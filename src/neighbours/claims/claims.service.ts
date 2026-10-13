import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { NeighbourItemClaim, NeighbourPost } from '@prisma/client';
import { CommunityNeighboursPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { BoardNotices } from '../posts/board-notices';
import { isClaimable } from '../posts/post-rules';
import {
  postNotFound,
  PostsService,
  type Person,
} from '../posts/posts.service';
import { ClaimDecisions } from './claim-decisions';

export const CLAIM_RESOURCE = 'neighbour_item_claim';
export const CLAIM_NOTE_LENGTH = { min: 1, max: 500 } as const;
/** A person's claims, and a post's, are few: one list. */
const LIST_CAP = 100;

export interface ClaimRead {
  claim: NeighbourItemClaim;
  post: Pick<NeighbourPost, 'id' | 'kind'>;
}

export interface StaffClaimRead {
  claim: NeighbourItemClaim;
  claimant: Person;
}

/** Who the item goes to: a pending claim, or someone who came without one. */
export interface Handover {
  claimId?: string;
  recipientAccountId?: string;
}

const PERSON = { select: { id: true, fullName: true, status: true } } as const;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const claimNotFound = () =>
  appError.notFound(ErrorCode.NEIGHBOUR_CLAIM_NOT_FOUND, 'Claim not found');

/**
 * Claims on found items, and the handover at the office (ADR 0042). A
 * found item is held by the management: a resident says it is theirs, the
 * staff decide, and record to whom it went and when. The handover closes
 * the post and declines whoever else was waiting.
 *
 * Every write takes the post's row first: a claim and a handover on the
 * same item are decided one at a time, and the one that lost reads the
 * post the other left.
 */
@Injectable()
export class ClaimsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly posts: PostsService,
    private readonly decisions: ClaimDecisions,
    private readonly community: CommunityNeighboursPort,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notices: BoardNotices,
  ) {}

  onModuleInit(): void {
    // No note: the stored replay of a claim holds no free text.
    this.idempotency.renderer(CLAIM_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const c = await tx.neighbourItemClaim.findUniqueOrThrow({
          where: { id },
        });
        return { id: c.id, status: c.status, createdAt: c.createdAt };
      }),
    );
  }

  /** A resident says a found item is theirs. One pending claim each. */
  create(
    postId: string,
    input: { note?: string },
  ): Promise<NeighbourItemClaim> {
    const me = this.ctx.accountId;
    const note = input.note?.trim() || null;
    if (note !== null && note.length > CLAIM_NOTE_LENGTH.max)
      throw invalid([
        {
          field: 'note',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...CLAIM_NOTE_LENGTH },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CLAIM_RESOURCE, id });
      await this.self.lockSelf(tx);
      await this.posts.lock(tx, postId);
      const now = await dbNow(tx);
      const post = await this.posts.seen(tx, postId, now);
      if (!isClaimable(post.kind) || post.authorId === me)
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_POST_NOT_CLAIMABLE,
          'This post takes no claim from you',
        );
      this.posts.assertOpen(post, now);
      if (
        await tx.neighbourItemClaim.count({
          where: { postId, claimantId: me, status: 'pending' },
        })
      )
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_CLAIM_EXISTS,
          'You already claimed this item',
        );
      const claim = await tx.neighbourItemClaim.create({
        data: {
          id,
          tenantId: post.tenantId,
          postId,
          claimantId: me,
          note,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'neighbour_claim.created',
        targetId: id,
        metadata: { postId },
      });
      await this.notices.toHandlers(tx, post, 'neighbour_item.claimed');
      return claim;
    });
  }

  /** The caller's own claims, newest first. */
  listMine(): Promise<ClaimRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.neighbourItemClaim.findMany({
        where: { claimantId: this.ctx.accountId },
        include: { post: { select: { id: true, kind: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_CAP,
      });
      return rows.map(({ post, ...claim }) => ({ claim, post }));
    });
  }

  /** The claimant takes a pending claim back. */
  withdraw(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const found = await tx.neighbourItemClaim.findUnique({ where: { id } });
      if (!found || found.claimantId !== this.ctx.accountId)
        throw claimNotFound();
      const claim = await this.pending(tx, found);
      await tx.neighbourItemClaim.update({
        where: { id },
        data: { status: 'withdrawn', decidedAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'neighbour_claim.withdrawn',
        targetId: id,
        metadata: { postId: claim.postId },
      });
    });
  }

  // --------------------------------------------------------------------------
  // The desk
  // --------------------------------------------------------------------------

  /** Every claim on a post, with who made it: oldest first. */
  listForPost(postId: string): Promise<StaffClaimRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.neighbourPost.count({ where: { id: postId } })))
        throw postNotFound();
      const rows = await tx.neighbourItemClaim.findMany({
        where: { postId },
        include: { claimant: PERSON },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: LIST_CAP,
      });
      return rows.map(({ claimant, ...claim }) => ({ claim, claimant }));
    });
  }

  /** The staff decline a pending claim: its claimant is told. */
  decline(id: string, reason: string | undefined): Promise<void> {
    const reasonCode = requireReasonCodeOnly(
      reason,
      REASON_CODES.neighbourClaimDecline,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const found = await tx.neighbourItemClaim.findUnique({ where: { id } });
      if (!found) throw claimNotFound();
      const claim = await this.pending(tx, found);
      await tx.neighbourItemClaim.update({
        where: { id },
        data: {
          status: 'declined',
          declineReason: reasonCode,
          decidedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'neighbour_claim.declined',
        targetId: id,
        metadata: { postId: claim.postId, reasonCode },
      });
      const post = await tx.neighbourPost.findUniqueOrThrow({
        where: { id: claim.postId },
      });
      await this.notices.to(
        tx,
        [claim.claimantId],
        post,
        'neighbour_claim.declined',
      );
    });
  }

  /**
   * The item leaves the office: to the claimant of a pending claim, or to a
   * resident who came without one. Recorded once per post (who, by whom,
   * when); the post closes as handed over and every other pending claim is
   * declined.
   */
  handOver(postId: string, input: Handover): Promise<void> {
    if (
      (input.claimId === undefined) ===
      (input.recipientAccountId === undefined)
    )
      throw invalid([
        {
          field: input.claimId === undefined ? 'claimId' : 'recipientAccountId',
          code:
            input.claimId === undefined
              ? FieldErrorCode.FIELD_REQUIRED
              : FieldErrorCode.FIELD_NOT_ALLOWED,
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const recipientId = input.recipientAccountId
        ? await this.walkIn(tx, input.recipientAccountId)
        : null;
      await this.posts.lock(tx, postId);
      const post = await tx.neighbourPost.findUnique({ where: { id: postId } });
      if (!post) throw postNotFound();
      if (!isClaimable(post.kind))
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_POST_NOT_CLAIMABLE,
          'Only a found item is handed over',
        );
      const now = await dbNow(tx);
      // An item nobody came for in time is still at the office.
      this.posts.assertOpen(post, now, { expired: true });
      let claim: NeighbourItemClaim | null = null;
      if (input.claimId) {
        claim = await tx.neighbourItemClaim.findFirst({
          where: { id: input.claimId, postId },
        });
        if (!claim) throw claimNotFound();
        this.assertPending(claim);
        await tx.neighbourItemClaim.update({
          where: { id: claim.id },
          data: { status: 'handed_over', decidedAt: now },
        });
      }
      const recipient = claim?.claimantId ?? recipientId!;
      await tx.neighbourItemHandover.create({
        data: {
          id: newId(),
          tenantId: post.tenantId,
          postId,
          claimId: claim?.id ?? null,
          recipientId: recipient,
          handedById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await this.decisions.declinePending(
        tx,
        post,
        'handed_to_another',
        now,
        claim?.id ?? null,
      );
      await this.posts.end(
        tx,
        post,
        'handed_over',
        now,
        'neighbour_item.handed_over',
        { claimId: claim?.id ?? null, recipientAccountId: recipient },
      );
      await this.notices.to(
        tx,
        [recipient],
        post,
        'neighbour_item.handed_over',
      );
    });
  }

  /**
   * Someone at the desk with no claim: an active resident or family account
   * of the compound, its row shared-locked so an erasure waits for this.
   */
  private async walkIn(tx: TenantTxClient, accountId: string): Promise<string> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${accountId}::uuid FOR SHARE`;
    if (
      rows[0]?.status !== 'active' ||
      !(await this.community.isResident(tx, accountId))
    )
      throw invalid([
        {
          field: 'recipientAccountId',
          code: FieldErrorCode.RECIPIENT_NOT_ELIGIBLE,
        },
      ]);
    return accountId;
  }

  /**
   * The claim again, under its post's lock: whatever decided it in the
   * meantime (a handover, the post closing) is seen, and refused with the
   * status found.
   */
  private async pending(
    tx: TenantTxClient,
    found: NeighbourItemClaim,
  ): Promise<NeighbourItemClaim> {
    await this.posts.lock(tx, found.postId);
    const claim = await tx.neighbourItemClaim.findUniqueOrThrow({
      where: { id: found.id },
    });
    this.assertPending(claim);
    return claim;
  }

  private assertPending(claim: NeighbourItemClaim): void {
    if (claim.status !== 'pending')
      throw appError.conflict(
        ErrorCode.NEIGHBOUR_CLAIM_INVALID_STATE,
        `The claim is ${claim.status}`,
        { params: { status: claim.status } },
      );
  }
}
