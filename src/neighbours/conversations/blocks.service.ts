import { Injectable } from '@nestjs/common';
import type { NeighbourBlock } from '@prisma/client';
import { CommunityNeighboursPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { otherOf, sideOf } from './masking';

/** A block's list is short: one list, newest first. */
const LIST_CAP = 100;

/** A block as its maker sees it: the other by building, never by name. */
export interface BlockRead {
  block: NeighbourBlock;
  building: string | null;
}

export const blockNotFound = () =>
  appError.notFound(ErrorCode.NEIGHBOUR_BLOCK_NOT_FOUND, 'Block not found');

/**
 * Blocks between two residents (ADR 0042). A block is made from a
 * conversation, by one of its sides, against the other: the blocker never
 * learns who that is. From then on neither starts a conversation with the
 * other, whichever of them blocked, and neither sees the other's posts.
 * The blocked side is told nothing: what it had open with the blocker
 * simply reads as closed, like a conversation whose post is gone.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly community: CommunityNeighboursPort,
    private readonly audit: AuditService,
  ) {}

  /** Whether either of the two has blocked the other. Call under the pair's lock. */
  async between(tx: TenantTxClient, a: string, b: string): Promise<boolean> {
    return (
      (await tx.neighbourBlock.count({
        where: {
          OR: [
            { blockerId: a, blockedId: b },
            { blockerId: b, blockedId: a },
          ],
        },
      })) > 0
    );
  }

  /**
   * The caller blocks the other side of one of their conversations. Under
   * the pair's lock (the one a new conversation between the two takes): the
   * block is written and every conversation still open between them, on any
   * post, closes. Blocking again changes nothing.
   */
  block(conversationId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const c = await tx.neighbourConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, tenantId: true, authorId: true, responderId: true },
      });
      const side = c && sideOf(c, me);
      if (!c || !side)
        throw appError.notFound(
          ErrorCode.NEIGHBOUR_CONVERSATION_NOT_FOUND,
          'Conversation not found',
        );
      const other = otherOf(c, side);
      await this.self.lockPair(tx, me, other);
      const existing = await tx.neighbourBlock.count({
        where: { blockerId: me, blockedId: other },
      });
      const now = await dbNow(tx);
      if (!existing)
        await tx.neighbourBlock.create({
          data: {
            id: newId(),
            tenantId: c.tenantId,
            blockerId: me,
            blockedId: other,
            conversationId: c.id,
            createdAt: now,
          },
        });
      const closed = await this.closeBetween(tx, me, other, 'blocked', now);
      if (!existing)
        await this.audit.record(tx, {
          action: 'neighbour_conversation.blocked',
          targetId: c.id,
          metadata: { conversationsClosed: closed },
        });
    });
  }

  /**
   * Closes every conversation still open between two accounts, their rows
   * locked in id order. Returns how many closed.
   */
  async closeBetween(
    tx: TenantTxClient,
    a: string,
    b: string,
    reason: 'blocked',
    now: Date,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM neighbour_conversations
       WHERE closed_at IS NULL
         AND ((author_account_id = ${a}::uuid AND responder_account_id = ${b}::uuid)
           OR (author_account_id = ${b}::uuid AND responder_account_id = ${a}::uuid))
       ORDER BY id FOR UPDATE`;
    for (const row of rows)
      await tx.neighbourConversation.update({
        where: { id: row.id },
        data: { closedAt: now, closeReason: reason },
      });
    return rows.length;
  }

  /** The caller's own blocks: the building each was written from, and when. */
  listMine(): Promise<BlockRead[]> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const blocks = await tx.neighbourBlock.findMany({
        where: { blockerId: me },
        include: {
          conversation: {
            select: {
              authorId: true,
              responderUnitId: true,
              post: { select: { authorUnitId: true } },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_CAP,
      });
      // The blocked side's unit: the post's if they wrote it, else their own.
      const reads = blocks.map(({ conversation, ...block }) => ({
        block,
        unitId:
          conversation.authorId === block.blockedId
            ? conversation.post.authorUnitId
            : conversation.responderUnitId,
      }));
      const units = await this.community.units(
        tx,
        reads.flatMap((r) => r.unitId ?? []),
      );
      return reads.map(({ block, unitId }) => ({
        block,
        building: unitId ? (units.get(unitId)?.building ?? null) : null,
      }));
    });
  }

  /**
   * The caller undoes one of their blocks. What it closed stays closed;
   * the two may meet again on a new post.
   */
  unblock(id: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const found = await tx.neighbourBlock.findUnique({ where: { id } });
      if (!found || found.blockerId !== me) throw blockNotFound();
      await this.self.lockPair(tx, me, found.blockedId);
      const { count } = await tx.neighbourBlock.deleteMany({
        where: { id, blockerId: me },
      });
      if (!count) throw blockNotFound();
      await this.audit.record(tx, {
        action: 'neighbour_conversation.unblocked',
        targetId: found.conversationId,
      });
    });
  }
}
