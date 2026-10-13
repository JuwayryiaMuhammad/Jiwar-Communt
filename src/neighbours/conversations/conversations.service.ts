import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  NeighbourConversation,
  NeighbourConversationMessage,
  NeighbourPost,
} from '@prisma/client';
import { CommunityNeighboursPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import type { NotificationKind } from '../../core/notifications/kinds';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { isLive, postState, type PostState } from '../posts/post-rules';
import { postNotFound, PostsService } from '../posts/posts.service';
import { NeighbourSettingsService } from '../settings/neighbour-settings.service';
import { BlocksService } from './blocks.service';
import {
  agreed,
  masked,
  namesRevealed,
  otherOf,
  otherSide,
  sideOf,
  type ConversationSide,
  type MaskedParty,
} from './masking';

export const CONVERSATION_RESOURCE = 'neighbour_conversation';
export const CONVERSATION_MESSAGE_RESOURCE = 'neighbour_conversation_message';
export const CONVERSATION_MESSAGE_LENGTH = { min: 1, max: 2000 } as const;
const DAY = 86_400_000;

/** A conversation as one of its two sides reads it. */
export interface ConversationRead {
  conversation: NeighbourConversation;
  post: Pick<NeighbourPost, 'id' | 'kind'>;
  postState: PostState;
  side: ConversationSide;
  /** Something may still be written in it. */
  open: boolean;
  other: MaskedParty;
  namesRevealed: boolean;
  iAgreed: boolean;
  theyAgreed: boolean;
}

export interface ConversationMessageRead {
  message: NeighbourConversationMessage;
  mine: boolean;
}

type WithPost = NeighbourConversation & { post: NeighbourPost };

/** The most recently written in first. */
const LIST = keysetCursor('lastMessageAt');
/** Oldest first: a conversation reads top to bottom. */
const THREAD = keysetCursor('createdAt', 'asc');

export const conversationNotFound = () =>
  appError.notFound(
    ErrorCode.NEIGHBOUR_CONVERSATION_NOT_FOUND,
    'Conversation not found',
  );

const closed = () =>
  appError.conflict(
    ErrorCode.NEIGHBOUR_CONVERSATION_CLOSED,
    'Nothing more is written in this conversation',
  );

/**
 * Masked contact on a board post (ADR 0042): the post's author and one
 * responder, each "a resident of building X" to the other until BOTH agree
 * to show names, and then a first name and nothing more.
 *
 * Nobody but its two sides reads a conversation: every read and write
 * finds the caller's side first, and anyone else gets the one not-found.
 * The staff have no route here at all (ReportsService is their only door,
 * and only onto a reported conversation).
 *
 * Locks, in order: the caller's account row; the caller's quota; the pair
 * of accounts (shared with a block between them); the conversation's row;
 * the settings row.
 */
@Injectable()
export class ConversationsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly posts: PostsService,
    private readonly blocks: BlocksService,
    private readonly settings: NeighbourSettingsService,
    private readonly community: CommunityNeighboursPort,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    // Neither stored replay holds a word anyone wrote.
    this.idempotency.renderer(CONVERSATION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const c = await tx.neighbourConversation.findUniqueOrThrow({
          where: { id },
        });
        return { id: c.id, createdAt: c.createdAt };
      }),
    );
    this.idempotency.renderer(CONVERSATION_MESSAGE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const m = await tx.neighbourConversationMessage.findUniqueOrThrow({
          where: { id },
        });
        return { id: m.id, createdAt: m.createdAt };
      }),
    );
  }

  /**
   * A resident writes to whoever posted, about the post. One conversation
   * per post and responder. What an account may start in 24 hours is
   * counted under its quota lock; a block between the two, either way, is
   * read under the pair's lock, so a block and a new conversation between
   * the same two are decided one at a time. A block answers as a post that
   * is not there: the blocked side learns nothing from the refusal.
   */
  start(
    postId: string,
    input: { body: string },
  ): Promise<NeighbourConversation> {
    const me = this.ctx.accountId;
    const body = this.body(input.body);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CONVERSATION_RESOURCE, id });
      await this.self.lockSelf(tx);
      await this.self.lockQuota(tx, me);
      const post = await this.posts.seen(tx, postId, await dbNow(tx));
      if (post.authorSide !== 'resident' || post.authorId === me)
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_POST_NO_CONTACT,
          'Nobody to write to about this post',
        );
      await this.self.lockPair(tx, me, post.authorId);
      if (await this.blocks.between(tx, me, post.authorId))
        throw postNotFound();
      const existing = await tx.neighbourConversation.findFirst({
        where: { postId, responderId: me },
        select: { id: true },
      });
      if (existing)
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_CONVERSATION_EXISTS,
          'You already wrote about this post',
          { params: { conversationId: existing.id } },
        );
      const places = await this.community.places(tx, me);
      if (!places.length)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only someone with a unit in the compound writes to a neighbour',
        );
      const { maxNewConversationsPerDay: max } = await this.settings.share(tx);
      const now = await dbNow(tx);
      // The post again, by the clock this request decides on.
      if (!isLive(post, now)) throw postNotFound();
      const started = await tx.neighbourConversation.count({
        where: {
          responderId: me,
          createdAt: { gt: new Date(now.getTime() - DAY) },
        },
      });
      if (started >= max)
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_CONVERSATION_LIMIT_REACHED,
          'Too many new conversations today',
          { params: { max } },
        );
      const conversation = await tx.neighbourConversation.create({
        data: {
          id,
          tenantId: post.tenantId,
          postId,
          authorId: post.authorId,
          responderId: me,
          responderUnitId: places[0].id,
          lastMessageAt: now,
          createdAt: now,
        },
      });
      await this.write(tx, conversation, body, now);
      await this.audit.record(tx, {
        action: 'neighbour_conversation.started',
        targetId: id,
        metadata: { postId, postKind: post.kind },
      });
      await this.tell(
        tx,
        post.authorId,
        post,
        id,
        'neighbour_conversation.started',
      );
      return conversation;
    });
  }

  /** The conversations the caller is one side of, the latest written first. */
  listMine(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<ConversationRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.neighbourConversation.findMany({
        where: {
          AND: [
            { OR: [{ authorId: me }, { responderId: me }] },
            ...LIST.after(q.cursor),
          ],
        },
        include: { post: true },
        orderBy: LIST.orderBy,
        take: limit + 1,
      });
      const page = LIST.toPage(rows, limit);
      const now = await dbNow(tx);
      const items: ConversationRead[] = [];
      for (const c of page.items) items.push(await this.read(tx, c, now));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<ConversationRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.read(tx, await this.mine(tx, id), await dbNow(tx)),
    );
  }

  /** Its messages, each marked as the caller's or not: no sender is named. */
  thread(
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<ConversationMessageRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.mine(tx, id);
      const limit = clampLimit(q.limit);
      const rows = await tx.neighbourConversationMessage.findMany({
        where: { AND: [{ conversationId: id }, ...THREAD.after(q.cursor)] },
        orderBy: THREAD.orderBy,
        take: limit + 1,
      });
      const page = THREAD.toPage(rows, limit);
      return {
        items: page.items.map((message) => ({
          message,
          mine: message.senderId === me,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** One side writes; the other is told, by the post's kind alone. */
  post(
    id: string,
    input: { body: string },
  ): Promise<NeighbourConversationMessage> {
    const body = this.body(input.body);
    return this.tenantTx.withTenantTx(async (tx) => {
      const messageId = newId();
      await this.idempotency.claim(tx, {
        type: CONVERSATION_MESSAGE_RESOURCE,
        id: messageId,
      });
      await this.self.lockSelf(tx);
      const c = await this.mine(tx, id, { lock: true });
      const now = await dbNow(tx);
      this.assertWritable(c, now);
      const message = await this.write(tx, c, body, now, messageId);
      await tx.neighbourConversation.update({
        where: { id },
        data: { lastMessageAt: now },
      });
      const side = sideOf(c, this.ctx.accountId)!;
      await this.tell(
        tx,
        otherOf(c, side),
        c.post,
        id,
        'neighbour_conversation.message',
      );
      return message;
    });
  }

  /**
   * The caller agrees to show names. Nothing shows until the other side
   * agrees too; when it has, both first names show from this commit on and
   * neither agreement is taken back. Two agreements at once both take the
   * conversation's row: the second finds the first.
   */
  reveal(id: string): Promise<ConversationRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const c = await this.mine(tx, id, { lock: true });
      const now = await dbNow(tx);
      const side = sideOf(c, this.ctx.accountId)!;
      if (agreed(c, side)) return this.read(tx, c, now);
      this.assertWritable(c, now);
      const updated = await tx.neighbourConversation.update({
        where: { id },
        data:
          side === 'author'
            ? { authorRevealAt: now }
            : { responderRevealAt: now },
        include: { post: true },
      });
      const both = namesRevealed(updated);
      if (both)
        await this.audit.record(tx, {
          action: 'neighbour_conversation.names_revealed',
          targetId: id,
          metadata: { postId: c.postId },
        });
      await this.tell(
        tx,
        otherOf(c, side),
        c.post,
        id,
        both
          ? 'neighbour_conversation.names_revealed'
          : 'neighbour_conversation.reveal_requested',
      );
      return this.read(tx, updated, now);
    });
  }

  /** The caller takes their agreement back: only while the other has not agreed. */
  unreveal(id: string): Promise<ConversationRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const c = await this.mine(tx, id, { lock: true });
      const now = await dbNow(tx);
      if (namesRevealed(c))
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_NAMES_ALREADY_REVEALED,
          'Names are shown and stay shown',
        );
      const side = sideOf(c, this.ctx.accountId)!;
      if (!agreed(c, side)) return this.read(tx, c, now);
      const updated = await tx.neighbourConversation.update({
        where: { id },
        data:
          side === 'author'
            ? { authorRevealAt: null }
            : { responderRevealAt: null },
        include: { post: true },
      });
      return this.read(tx, updated, now);
    });
  }

  /**
   * The conversation, if the caller is one of its two sides; otherwise the
   * one not-found, as for an unknown id or another compound's.
   */
  async mine(
    tx: TenantTxClient,
    id: string,
    opts: { lock?: boolean } = {},
  ): Promise<WithPost> {
    if (opts.lock)
      await tx.$queryRaw`SELECT id FROM neighbour_conversations WHERE id = ${id}::uuid FOR UPDATE`;
    const c = await tx.neighbourConversation.findUnique({
      where: { id },
      include: { post: true },
    });
    if (!c || sideOf(c, this.ctx.accountId) === null)
      throw conversationNotFound();
    return c;
  }

  /** Not closed, and its post still on its board. */
  writable(c: WithPost, now: Date): boolean {
    return c.closedAt === null && isLive(c.post, now);
  }

  private assertWritable(c: WithPost, now: Date): void {
    if (!this.writable(c, now)) throw closed();
  }

  /** The trimmed body, or INVALID_LENGTH on `body`. */
  private body(text: string): string {
    const body = text.trim();
    if (
      body.length < CONVERSATION_MESSAGE_LENGTH.min ||
      body.length > CONVERSATION_MESSAGE_LENGTH.max
    )
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid message',
        {
          fields: [
            {
              field: 'body',
              code: FieldErrorCode.INVALID_LENGTH,
              params: { ...CONVERSATION_MESSAGE_LENGTH },
            },
          ],
        },
      );
    return body;
  }

  private write(
    tx: TenantTxClient,
    c: Pick<NeighbourConversation, 'id' | 'tenantId'>,
    body: string,
    at: Date,
    id = newId(),
  ): Promise<NeighbourConversationMessage> {
    return tx.neighbourConversationMessage.create({
      data: {
        id,
        tenantId: c.tenantId,
        conversationId: c.id,
        senderId: this.ctx.accountId,
        body,
        createdAt: at,
      },
    });
  }

  /** One inbox row for the other side, if still active: the post's kind only. */
  private async tell(
    tx: TenantTxClient,
    accountId: string,
    post: Pick<NeighbourPost, 'kind'>,
    conversationId: string,
    kind: NotificationKind,
  ): Promise<void> {
    const active = await tx.account.count({
      where: { id: accountId, status: 'active' },
    });
    if (!active) return;
    await this.notifier.notify(tx, [accountId], {
      kind,
      params: { postKind: post.kind },
      targetId: conversationId,
    });
  }

  /** What the caller's side is shown: the other by building, and by first name once both agreed. */
  private async read(
    tx: TenantTxClient,
    c: WithPost,
    now: Date,
  ): Promise<ConversationRead> {
    const side = sideOf(c, this.ctx.accountId)!;
    const other = await tx.account.findUniqueOrThrow({
      where: { id: otherOf(c, side) },
      select: { fullName: true, status: true },
    });
    // The author wrote from the post's unit, the responder from their own.
    const unitId = side === 'author' ? c.responderUnitId : c.post.authorUnitId;
    const unit = unitId ? await this.community.unit(tx, unitId) : null;
    const { post, ...conversation } = c;
    return {
      conversation,
      post: { id: post.id, kind: post.kind },
      postState: postState(post, now),
      side,
      open: this.writable(c, now),
      other: masked(c, { building: unit?.building ?? null, ...other }),
      namesRevealed: namesRevealed(c),
      iAgreed: agreed(c, side),
      theyAgreed: agreed(c, otherSide(side)),
    };
  }
}
