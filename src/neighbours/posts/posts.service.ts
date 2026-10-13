import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  NeighbourClaimStatus,
  NeighbourPost,
  NeighbourPostKind,
  Prisma,
} from '@prisma/client';
import { CommunityNeighboursPort, type NeighbourUnit } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
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
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { NeighbourAccess } from '../access';
import { ClaimDecisions } from '../claims/claim-decisions';
import { dbNow } from '../db-clock';
import { NeighbourSettingsService } from '../settings/neighbour-settings.service';
import { BoardNotices } from './board-notices';
import {
  BOARD_KINDS,
  boardOf,
  expiresAt,
  isLive,
  parseDay,
  postState,
  stateWhere,
  type Board,
  type PostState,
} from './post-rules';
import { PostVisibility } from './post-visibility';
import { PostCreatedView } from './views/post.views';

export const POST_RESOURCE = 'neighbour_post';
export const POST_BODY_LENGTH = { min: 1, max: 500 } as const;
export const POST_PLACE_LENGTH = { min: 1, max: 120 } as const;
/** Photos on one post. */
export const MAX_PHOTOS = 3;

export interface NewPost {
  kind: NeighbourPostKind;
  body: string;
  place?: string;
  /** `YYYY-MM-DD`: the day it was lost or found. */
  occurredOn?: string;
  /** One of the author's own units, when they have several. */
  unitId?: string;
  photoFileIds?: string[];
}

export interface BoardQuery {
  cursor?: string;
  limit?: number;
  board?: Board;
  kind?: NeighbourPostKind;
  /** `'true'`: the caller's own posts, whatever their state. */
  mine?: 'true' | 'false';
}

export interface StaffPostsQuery {
  cursor?: string;
  limit?: number;
  board?: Board;
  kind?: NeighbourPostKind;
  state?: PostState;
}

export interface PhotoRead {
  id: string;
  contentType: string;
  /** Null when the file is gone. */
  read: PresignedRead | null;
}

export interface Person {
  id: string;
  fullName: string | null;
  status: string;
}

/** A post as a resident reads it on a board. */
export interface PostRead {
  post: NeighbourPost;
  state: PostState;
  mine: boolean;
  /** The resident author's unit, for its building alone; null for the staff's. */
  authorUnit: NeighbourUnit | null;
  photos: PhotoRead[];
  /** The caller's latest claim on it, when it is a found item. */
  myClaim: { id: string; status: NeighbourClaimStatus } | null;
}

export interface HandoverRead {
  claimId: string | null;
  recipient: Person;
  handedBy: Person;
  createdAt: Date;
}

/** A post as the staff see it at the desk. */
export interface StaffPostRead {
  post: NeighbourPost;
  state: PostState;
  author: Person;
  authorUnit: NeighbourUnit | null;
  photos: PhotoRead[];
  pendingClaims: number;
  handover: HandoverRead | null;
}

/** Newest first. */
const PAGE = keysetCursor('createdAt');
const PERSON = { select: { id: true, fullName: true, status: true } } as const;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid post', { fields });

export const postNotFound = () =>
  appError.notFound(ErrorCode.NEIGHBOUR_POST_NOT_FOUND, 'Post not found');

/**
 * The lost-and-found and lending boards (ADR 0042), compound-wide. A
 * resident's post shows no name: only "a resident of building X", from the
 * unit they posted from. The staff post lost and found items as the
 * management, and take down any post with a reason code.
 *
 * A post leaves its board on its day by the reader's clock (post-rules);
 * no job closes it. Its author keeps seeing it; the desk sees it flagged.
 */
@Injectable()
export class PostsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly settings: NeighbourSettingsService,
    private readonly community: CommunityNeighboursPort,
    private readonly visibility: PostVisibility,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly claims: ClaimDecisions,
    private readonly notices: BoardNotices,
  ) {}

  onModuleInit(): void {
    // A replay whose stored body was lost renders the post as created.
    this.idempotency.renderer(POST_RESOURCE, async (id) =>
      PostCreatedView.from(
        await this.tenantTx.withTenantTx((tx) =>
          tx.neighbourPost.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /**
   * A resident posts on a board. What they may have on the boards at once
   * is counted and then written under the account's quota lock, so two
   * posts at once cannot both be the last one allowed.
   */
  create(input: NewPost): Promise<NeighbourPost> {
    const me = this.ctx.accountId;
    const text = this.text(input);
    const photoIds = this.photoIds(input.photoFileIds);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: POST_RESOURCE, id });
      await this.self.lockSelf(tx);
      await this.self.lockQuota(tx, me);
      const places = await this.community.places(tx, me);
      if (!places.length)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only someone with a unit in the compound posts on the boards',
        );
      if (input.unitId && !places.some((p) => p.id === input.unitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const settings = await this.settings.share(tx);
      const now = await dbNow(tx);
      const live = await tx.neighbourPost.count({
        where: { authorId: me, ...stateWhere('open', now) },
      });
      if (live >= settings.maxOpenPosts)
        throw appError.conflict(
          ErrorCode.NEIGHBOUR_POST_LIMIT_REACHED,
          'Too many posts on the boards',
          { params: { max: settings.maxOpenPosts } },
        );
      return this.insert(tx, id, input, text, photoIds, now, {
        side: 'resident',
        // The first of several is as good as any: only its building shows.
        unitId: input.unitId ?? places[0].id,
        expiresAt: expiresAt(input.kind, now, settings),
      });
    });
  }

  /** The staff post what was lost or found, as the management. */
  createByStaff(input: NewPost): Promise<NeighbourPost> {
    const text = this.text(input);
    const photoIds = this.photoIds(input.photoFileIds);
    const fields: FieldError[] = [];
    if (boardOf(input.kind) !== 'lost_found')
      fields.push({
        field: 'kind',
        code: FieldErrorCode.INVALID_VALUE,
        params: { allowed: [...BOARD_KINDS.lost_found] },
      });
    if (input.unitId !== undefined)
      fields.push({ field: 'unitId', code: FieldErrorCode.FIELD_NOT_ALLOWED });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: POST_RESOURCE, id });
      await this.self.lockSelf(tx);
      const settings = await this.settings.share(tx);
      const now = await dbNow(tx);
      return this.insert(tx, id, input, text, photoIds, now, {
        side: 'staff',
        unitId: null,
        expiresAt: expiresAt(input.kind, now, settings),
      });
    });
  }

  private text(input: NewPost): { body: string; place: string | null } {
    const body = input.body.trim();
    const place = input.place?.trim() || null;
    const fields: FieldError[] = [];
    if (
      body.length < POST_BODY_LENGTH.min ||
      body.length > POST_BODY_LENGTH.max
    )
      fields.push({
        field: 'body',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...POST_BODY_LENGTH },
      });
    if (place !== null && place.length > POST_PLACE_LENGTH.max)
      fields.push({
        field: 'place',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...POST_PLACE_LENGTH },
      });
    if (input.occurredOn !== undefined && boardOf(input.kind) === 'lending')
      fields.push({
        field: 'occurredOn',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (fields.length) throw invalid(fields);
    return { body, place };
  }

  /** At most MAX_PHOTOS, each once. */
  private photoIds(ids: readonly string[] | undefined): string[] {
    const unique = [...new Set(ids ?? [])];
    if (unique.length > MAX_PHOTOS)
      throw invalid([
        {
          field: 'photoFileIds',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 0, max: MAX_PHOTOS },
        },
      ]);
    return unique;
  }

  private async insert(
    tx: TenantTxClient,
    id: string,
    input: NewPost,
    text: { body: string; place: string | null },
    photoIds: readonly string[],
    now: Date,
    by: { side: 'resident' | 'staff'; unitId: string | null; expiresAt: Date },
  ): Promise<NeighbourPost> {
    const occurredOn =
      input.occurredOn === undefined ? null : parseDay(input.occurredOn, now);
    if (input.occurredOn !== undefined && occurredOn === null)
      throw invalid([
        { field: 'occurredOn', code: FieldErrorCode.INVALID_VALUE },
      ]);
    const tenantId = this.ctx.tenantId;
    const post = await tx.neighbourPost.create({
      data: {
        id,
        tenantId,
        kind: input.kind,
        authorId: this.ctx.accountId,
        authorSide: by.side,
        authorUnitId: by.unitId,
        body: text.body,
        place: text.place,
        occurredOn,
        expiresAt: by.expiresAt,
        createdAt: now,
      },
    });
    for (const [i, fileId] of photoIds.entries()) {
      const file = await this.files.claim(tx, fileId, 'neighbour_post_photo');
      if (!file)
        throw invalid([
          {
            field: `photoFileIds.${i}`,
            code: FieldErrorCode.FILE_NOT_AVAILABLE,
          },
        ]);
      await this.files.attach(tx, file);
      await tx.neighbourPostPhoto.create({
        data: {
          id: newId(),
          tenantId,
          postId: id,
          fileId: file.id,
          createdAt: now,
        },
      });
    }
    await this.audit.record(tx, {
      action: 'neighbour_post.created',
      targetId: id,
      metadata: { kind: post.kind, side: by.side, photos: photoIds.length },
    });
    return post;
  }

  // --------------------------------------------------------------------------
  // The resident's side
  // --------------------------------------------------------------------------

  /**
   * A board as a resident reads it, newest first: the posts still on it,
   * but those of anyone the caller is kept from seeing. `mine` is the
   * caller's own posts instead, whatever their state.
   */
  board(q: BoardQuery): Promise<Page<PostRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const where: Prisma.NeighbourPostWhereInput =
        q.mine === 'true'
          ? { authorId: me }
          : {
              ...stateWhere('open', now),
              authorId: { notIn: await this.visibility.hiddenAuthors(tx, me) },
            };
      const page = await this.rows(tx, { AND: [where, this.byKind(q)] }, q);
      return { ...page, items: await this.forResident(tx, page.items, now) };
    });
  }

  get(id: string): Promise<PostRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const post = await this.seen(tx, id, now);
      return (await this.forResident(tx, [post], now))[0];
    });
  }

  /**
   * A post as a resident may read it, or NEIGHBOUR_POST_NOT_FOUND: their
   * own in any state; anyone else's only while it is on its board and its
   * author is not hidden from them. One answer for the rest.
   */
  async seen(
    tx: TenantTxClient,
    id: string,
    now: Date,
    opts: { lock?: boolean } = {},
  ): Promise<NeighbourPost> {
    if (opts.lock) await this.lock(tx, id);
    const me = this.ctx.accountId;
    const post = await tx.neighbourPost.findUnique({ where: { id } });
    if (!post) throw postNotFound();
    if (post.authorId === me) return post;
    if (!isLive(post, now)) throw postNotFound();
    if ((await this.visibility.hiddenAuthors(tx, me)).includes(post.authorId))
      throw postNotFound();
    return post;
  }

  async lock(tx: TenantTxClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM neighbour_posts WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /** The author takes their post down, with a reason from the closed list. */
  close(id: string, reason: string | undefined): Promise<void> {
    const reasonCode = requireReasonCodeOnly(
      reason,
      REASON_CODES.neighbourPostClose,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      await this.lock(tx, id);
      const post = await tx.neighbourPost.findUnique({ where: { id } });
      if (!post || post.authorId !== this.ctx.accountId) throw postNotFound();
      const now = await dbNow(tx);
      this.assertOpen(post, now, { expired: true });
      await this.end(tx, post, reasonCode, now, 'neighbour_post.closed');
    });
  }

  // --------------------------------------------------------------------------
  // The desk
  // --------------------------------------------------------------------------

  listForStaff(q: StaffPostsQuery): Promise<Page<StaffPostRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const page = await this.rows(
        tx,
        { AND: [q.state ? stateWhere(q.state, now) : {}, this.byKind(q)] },
        q,
      );
      return { ...page, items: await this.forStaff(tx, page.items, now) };
    });
  }

  getForStaff(id: string): Promise<StaffPostRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const post = await tx.neighbourPost.findUnique({ where: { id } });
      if (!post) throw postNotFound();
      return (await this.forStaff(tx, [post], await dbNow(tx)))[0];
    });
  }

  /** The staff take a post down: its author is told, by the post's kind alone. */
  remove(id: string, reason: string | undefined): Promise<void> {
    const reasonCode = requireReasonCodeOnly(
      reason,
      REASON_CODES.neighbourPostRemove,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      await this.lock(tx, id);
      const post = await tx.neighbourPost.findUnique({ where: { id } });
      if (!post) throw postNotFound();
      const now = await dbNow(tx);
      this.assertOpen(post, now, { expired: true });
      await this.end(tx, post, reasonCode, now, 'neighbour_post.removed');
      await this.notices.to(
        tx,
        [post.authorId],
        post,
        'neighbour_post.removed',
        this.ctx.accountId,
      );
    });
  }

  /**
   * 409 NEIGHBOUR_POST_NOT_OPEN with the state found. `expired: true`
   * lets through a post whose day has passed but that nobody closed: it
   * may still be closed, taken down or handed over.
   */
  assertOpen(
    post: NeighbourPost,
    now: Date,
    opts: { expired?: boolean } = {},
  ): void {
    const state = postState(post, now);
    if (state === 'open' || (opts.expired && state === 'expired')) return;
    throw appError.conflict(
      ErrorCode.NEIGHBOUR_POST_NOT_OPEN,
      `The post is ${state}`,
      { params: { state } },
    );
  }

  /**
   * Under the post's lock: the post closes, and whatever claims were still
   * pending on it are declined with the system's reason. The handover
   * settles its claims itself before calling this.
   */
  async end(
    tx: TenantTxClient,
    post: NeighbourPost,
    reasonCode: string,
    now: Date,
    action:
      | 'neighbour_post.closed'
      | 'neighbour_post.removed'
      | 'neighbour_item.handed_over',
    metadata: Record<string, string | number | null> = {},
  ): Promise<void> {
    await tx.neighbourPost.update({
      where: { id: post.id },
      data: { status: 'closed', closedAt: now, closeReason: reasonCode },
    });
    await this.claims.declinePending(tx, post, 'post_closed', now);
    await this.audit.record(tx, {
      action,
      targetId: post.id,
      metadata: { kind: post.kind, reasonCode, ...metadata },
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  private byKind(q: {
    board?: Board;
    kind?: NeighbourPostKind;
  }): Prisma.NeighbourPostWhereInput {
    return {
      AND: [
        q.board ? { kind: { in: [...BOARD_KINDS[q.board]] } } : {},
        q.kind ? { kind: q.kind } : {},
      ],
    };
  }

  private async rows(
    tx: TenantTxClient,
    where: Prisma.NeighbourPostWhereInput,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<NeighbourPost>> {
    const limit = clampLimit(q.limit);
    const rows = await tx.neighbourPost.findMany({
      where: { AND: [where, ...PAGE.after(q.cursor)] },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    return PAGE.toPage(rows, limit);
  }

  private async photosOf(
    tx: TenantTxClient,
    postIds: readonly string[],
  ): Promise<Map<string, PhotoRead[]>> {
    const out = new Map<string, PhotoRead[]>();
    if (!postIds.length) return out;
    const rows = await tx.neighbourPostPhoto.findMany({
      where: { postId: { in: [...postIds] } },
      include: { file: { select: { contentType: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const p of rows) {
      const list = out.get(p.postId) ?? [];
      list.push({
        id: p.id,
        contentType: p.file.contentType,
        read: await this.files.readUrl(tx, p.fileId),
      });
      out.set(p.postId, list);
    }
    return out;
  }

  private unitsOf(tx: TenantTxClient, posts: readonly NeighbourPost[]) {
    return this.community.units(
      tx,
      posts.flatMap((p) => (p.authorUnitId ? [p.authorUnitId] : [])),
    );
  }

  async forResident(
    tx: TenantTxClient,
    posts: NeighbourPost[],
    now: Date,
  ): Promise<PostRead[]> {
    if (!posts.length) return [];
    const me = this.ctx.accountId;
    const ids = posts.map((p) => p.id);
    const photos = await this.photosOf(tx, ids);
    const units = await this.unitsOf(tx, posts);
    const claims = await tx.neighbourItemClaim.findMany({
      where: { postId: { in: ids }, claimantId: me },
      select: { id: true, postId: true, status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // The latest wins: a claim taken back and made again.
    const mine = new Map(claims.map((c) => [c.postId, c]));
    return posts.map((post) => {
      const claim = mine.get(post.id);
      return {
        post,
        state: postState(post, now),
        mine: post.authorId === me,
        authorUnit: post.authorUnitId
          ? (units.get(post.authorUnitId) ?? null)
          : null,
        photos: photos.get(post.id) ?? [],
        myClaim: claim ? { id: claim.id, status: claim.status } : null,
      };
    });
  }

  private async forStaff(
    tx: TenantTxClient,
    posts: NeighbourPost[],
    now: Date,
  ): Promise<StaffPostRead[]> {
    if (!posts.length) return [];
    const ids = posts.map((p) => p.id);
    const photos = await this.photosOf(tx, ids);
    const units = await this.unitsOf(tx, posts);
    const authors = new Map(
      (
        await tx.account.findMany({
          where: { id: { in: [...new Set(posts.map((p) => p.authorId))] } },
          ...PERSON,
        })
      ).map((a) => [a.id, a]),
    );
    const pending = new Map(
      (
        await tx.neighbourItemClaim.groupBy({
          by: ['postId'],
          where: { postId: { in: ids }, status: 'pending' },
          _count: { _all: true },
        })
      ).map((c) => [c.postId, c._count._all]),
    );
    const handovers = new Map(
      (
        await tx.neighbourItemHandover.findMany({
          where: { postId: { in: ids } },
          include: { recipient: PERSON, handedBy: PERSON },
        })
      ).map((h) => [h.postId, h]),
    );
    return posts.map((post) => {
      const handover = handovers.get(post.id);
      return {
        post,
        state: postState(post, now),
        author: authors.get(post.authorId)!,
        authorUnit: post.authorUnitId
          ? (units.get(post.authorUnitId) ?? null)
          : null,
        photos: photos.get(post.id) ?? [],
        pendingClaims: pending.get(post.id) ?? 0,
        handover: handover
          ? {
              claimId: handover.claimId,
              recipient: handover.recipient,
              handedBy: handover.handedBy,
              createdAt: handover.createdAt,
            }
          : null,
      };
    });
  }
}
