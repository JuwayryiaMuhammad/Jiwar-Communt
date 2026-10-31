import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type MarketListing,
  type MarketListingCategory,
  type MarketListingKind,
  type MarketListingStatus,
} from '@prisma/client';
import { CommunityNeighboursPort, type ListedUnitFacts } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import type { Changes } from '../../core/audit/diff';
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
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import {
  ENDED_STATUSES,
  expiryFrom,
  isOpen,
  isUnitKind,
  LISTING_BODY_LENGTH,
  LISTING_TITLE_LENGTH,
  liveWhere,
  MARKET_SEARCH_RATE,
  MAX_LISTING_PHOTOS,
  OPEN_STATUSES,
  priceProblem,
  stateOf,
  type SystemWithdrawal,
} from './market-rules';
import { MarketSettingsService } from './market-settings.service';
import { ShopsService } from './shops.service';

export const LISTING_RESOURCE = 'market_listing';

export interface NewListing {
  kind: MarketListingKind;
  category: MarketListingCategory;
  title: string;
  body: string;
  /** A decimal string; required to sell or for a unit, refused on a gift. */
  price?: string;
  negotiable?: boolean;
  /** The unit for sale or to let: the caller must own it. */
  unitId?: string;
  /** One of the caller's own units to list from, when they have several. */
  fromUnitId?: string;
  /** The caller's own active shop, to list under. */
  shopId?: string;
  photoFileIds?: string[];
}

export interface ListingPatch {
  category?: MarketListingCategory;
  title?: string;
  body?: string;
  /** `null` takes the price off (only where the kind allows none). */
  price?: string | null;
  negotiable?: boolean;
}

export type MarketSort = 'newest' | 'price_asc' | 'price_desc';

export interface MarketQuery {
  q?: string;
  kind?: MarketListingKind;
  category?: MarketListingCategory;
  minPrice?: string;
  maxPrice?: string;
  sort?: MarketSort;
  cursor?: string;
  limit?: number;
}

export interface StaffQueueQuery {
  cursor?: string;
  limit?: number;
  status?: 'pending_review' | 'under_review';
}

export interface PhotoRead {
  id: string;
  contentType: string;
  read: PresignedRead | null;
}

/** A listing as any resident reads it: the seller by building, never by name. */
export interface ListingRead {
  listing: MarketListing;
  state: MarketListingStatus;
  photos: PhotoRead[];
  /** The building the seller listed from (null when it names none). */
  building: string | null;
  mine: boolean;
  unit: ListedUnitFacts | null;
}

/** What the handlers read: the seller named, and the unit's code. */
export interface StaffListingRead extends ListingRead {
  seller: { id: string; fullName: string | null; status: string };
  sellerUnitCode: string | null;
  unitCode: string | null;
}

/** Newest first. */
const PAGE = keysetCursor('createdAt');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid listing', {
    fields,
  });

export const listingNotFound = () =>
  appError.notFound(ErrorCode.MARKET_LISTING_NOT_FOUND, 'Listing not found');

const ended = (status: MarketListingStatus) =>
  appError.conflict(ErrorCode.MARKET_LISTING_ENDED, 'The listing has ended', {
    params: { status },
  });

const notPending = (status: MarketListingStatus) =>
  appError.conflict(
    ErrorCode.MARKET_LISTING_NOT_PENDING,
    'The listing is not waiting for this decision',
    { params: { status } },
  );

/** The price cursor of a price sort: the price and the id, past which to read. */
function decodePriceCursor(cursor: string): { price: string; id: string } {
  try {
    const [price, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as [unknown, unknown];
    if (
      typeof price === 'string' &&
      /^\d{1,10}(\.\d{1,2})?$/.test(price) &&
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id)
    )
      return { price, id };
  } catch {
    // fall through
  }
  throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid cursor', {
    fields: [{ field: 'cursor', code: FieldErrorCode.INVALID_FORMAT }],
  });
}

const encodePriceCursor = (price: Prisma.Decimal, id: string): string =>
  Buffer.from(JSON.stringify([price.toFixed(2), id])).toString('base64url');

/**
 * The market (ADR 0071): residents list what they sell, give, want or
 * offer, and an owner lists a unit for sale or to let. A listing names no
 * seller: every reader sees "a resident of building X". When the compound
 * reviews (the default), a new or edited listing waits for a handler.
 *
 * Locks, in order: the caller's account row (FOR SHARE); the caller's
 * quota (an advisory lock); a listed unit's row; the listing's row (FOR
 * UPDATE); the settings row (FOR SHARE).
 */
@Injectable()
export class ListingsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly settings: MarketSettingsService,
    private readonly community: CommunityNeighboursPort,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly rateLimit: RateLimitService,
    private readonly shops: ShopsService,
  ) {}

  onModuleInit(): void {
    // A replay renders the listing as created: its id, kind, state and day.
    this.idempotency.renderer(LISTING_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const l = await tx.marketListing.findUniqueOrThrow({ where: { id } });
        return {
          id: l.id,
          kind: l.kind,
          status: l.status,
          expiresAt: l.expiresAt,
          createdAt: l.createdAt,
        };
      }),
    );
  }

  /**
   * A resident lists something. What they may have open at once is
   * counted and written under the quota lock, so two listings at once
   * cannot both be the last allowed. A unit is listed only by its owner,
   * under the unit's lock, once a kind.
   */
  create(input: NewListing): Promise<MarketListing> {
    const me = this.ctx.accountId;
    const text = this.text(input);
    const price = this.price(input.kind, input.price ?? null);
    const photoIds = this.photoIds(input.photoFileIds);
    this.unitShape(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: LISTING_RESOURCE, id });
      await this.self.lockSelf(tx);
      await this.self.lockQuota(tx, me);
      const places = await this.community.places(tx, me);
      if (!places.length)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only someone with a unit in the compound lists on the market',
        );
      if (input.fromUnitId && !places.some((p) => p.id === input.fromUnitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      let sellerUnitId = input.fromUnitId ?? places[0].id;
      if (input.unitId) {
        await this.community.lockUnit(tx, input.unitId);
        if (!(await this.community.ownsLive(tx, me, input.unitId)))
          throw appError.forbidden(
            ErrorCode.MARKET_UNIT_NOT_OWNED,
            'Only the unit’s owner lists it',
          );
        await this.assertUnitFree(tx, input.unitId, input.kind);
        sellerUnitId = input.unitId;
      }
      if (input.shopId) await this.shops.activeOf(tx, input.shopId);
      const settings = await this.settings.share(tx);
      const now = await dbNow(tx);
      const open = await tx.marketListing.count({
        where: { sellerId: me, ...this.openWhere(now) },
      });
      if (open >= settings.maxLivePerAccount)
        throw appError.conflict(
          ErrorCode.MARKET_LISTING_LIMIT_REACHED,
          'Too many listings open',
          { params: { max: settings.maxLivePerAccount } },
        );
      const status: MarketListingStatus = settings.requiresReview
        ? 'pending_review'
        : 'live';
      const tenantId = this.ctx.tenantId;
      const listing = await tx.marketListing.create({
        data: {
          id,
          tenantId,
          kind: input.kind,
          category: input.category,
          sellerId: me,
          sellerUnitId,
          unitId: input.unitId ?? null,
          shopId: input.shopId ?? null,
          title: text.title,
          body: text.body,
          price,
          negotiable: price === null ? false : (input.negotiable ?? false),
          status,
          expiresAt: expiryFrom(now, settings.expiryDays),
          createdAt: now,
        },
      });
      for (const [i, fileId] of photoIds.entries()) {
        const file = await this.files.claim(tx, fileId, 'market_listing_photo');
        if (!file)
          throw invalid([
            {
              field: `photoFileIds.${i}`,
              code: FieldErrorCode.FILE_NOT_AVAILABLE,
            },
          ]);
        await this.files.attach(tx, file);
        await tx.marketListingPhoto.create({
          data: {
            id: newId(),
            tenantId,
            listingId: id,
            fileId: file.id,
            position: i,
            createdAt: now,
          },
        });
      }
      await this.audit.record(tx, {
        action: 'market_listing.created',
        targetId: id,
        metadata: {
          kind: listing.kind,
          category: listing.category,
          status,
          unitId: listing.unitId,
          shopId: listing.shopId,
          photos: photoIds.length,
        },
      });
      return listing;
    });
  }

  /**
   * The seller changes their listing while it waits or is live. Where the
   * compound reviews, a live listing changed goes back for review.
   */
  update(id: string, patch: ListingPatch): Promise<ListingRead> {
    const fields: FieldError[] = [];
    const title = patch.title === undefined ? undefined : patch.title.trim();
    const body = patch.body === undefined ? undefined : patch.body.trim();
    if (title !== undefined && !within(title, LISTING_TITLE_LENGTH))
      fields.push(lengthError('title', LISTING_TITLE_LENGTH));
    if (body !== undefined && !within(body, LISTING_BODY_LENGTH))
      fields.push(lengthError('body', LISTING_BODY_LENGTH));
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const l = await this.lockMine(tx, id);
      const now = await dbNow(tx);
      const state = stateOf(l, now);
      if (!['pending_review', 'live'].includes(state)) {
        if (ENDED_STATUSES.includes(state)) throw ended(state);
        throw notPending(state);
      }
      if (patch.category !== undefined) {
        const unitCategory = patch.category === 'real_estate';
        if (unitCategory !== isUnitKind(l.kind))
          throw invalid([
            { field: 'category', code: FieldErrorCode.INVALID_VALUE },
          ]);
      }
      const price =
        patch.price === undefined
          ? l.price
          : this.price(l.kind, patch.price, 'price');
      const negotiable =
        price === null ? false : (patch.negotiable ?? l.negotiable);
      const settings = await this.settings.share(tx);
      const back = l.status === 'live' && settings.requiresReview;
      const updated = await tx.marketListing.update({
        where: { id },
        data: {
          category: patch.category,
          title,
          body,
          price,
          negotiable,
          status: back ? 'pending_review' : undefined,
        },
      });
      const changes: Changes = {};
      if (patch.category !== undefined && patch.category !== l.category)
        changes.category = { from: l.category, to: patch.category };
      if (title !== undefined && title !== l.title)
        changes.title = { changed: true };
      if (body !== undefined && body !== l.body)
        changes.body = { changed: true };
      if (!sameMoney(price, l.price))
        changes.price = {
          from: l.price?.toFixed(2) ?? null,
          to: price === null ? null : new Prisma.Decimal(price).toFixed(2),
        };
      if (negotiable !== l.negotiable)
        changes.negotiable = { from: l.negotiable, to: negotiable };
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'market_listing.updated',
          targetId: id,
          metadata: { backToReview: back },
          changes,
        });
      return this.read(tx, updated, now);
    });
  }

  /** The seller takes their listing off, whatever it was waiting for. */
  withdraw(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const l = await this.lockMine(tx, id);
      const now = await dbNow(tx);
      const state = stateOf(l, now);
      if (!isOpen(state)) throw ended(state);
      await this.end(tx, l, 'withdrawn', null, now);
      await this.audit.record(tx, {
        action: 'market_listing.withdrawn',
        targetId: id,
        metadata: { kind: l.kind, by: 'seller' },
      });
    });
  }

  /** The seller says it went: from the market, or while it is being reviewed. */
  sold(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const l = await this.lockMine(tx, id);
      const now = await dbNow(tx);
      const state = stateOf(l, now);
      if (state !== 'live' && state !== 'under_review') {
        if (ENDED_STATUSES.includes(state)) throw ended(state);
        throw notPending(state);
      }
      await this.end(tx, l, 'sold', null, now);
      await this.audit.record(tx, {
        action: 'market_listing.sold',
        targetId: id,
        metadata: { kind: l.kind },
      });
    });
  }

  /** The caller's own listings, every state, newest first. */
  listMine(q: { cursor?: string; limit?: number }): Promise<Page<ListingRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.marketListing.findMany({
        where: { AND: [{ sellerId: me }, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const now = await dbNow(tx);
      return {
        items: await this.readAll(tx, page.items, now),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * The market: live listings, searched by words (Postgres 'simple' text
   * search), kind, category and a price range, newest first or by price.
   * A price sort reads only listings with a price. Thirty searches a
   * minute an account, as `/me/search`.
   */
  async search(q: MarketQuery): Promise<Page<ListingRead>> {
    const me = this.ctx.accountId;
    const sort = q.sort ?? 'newest';
    const words = q.q?.trim() || null;
    if (words !== null)
      await this.rateLimit.consume(
        `market-search:${this.ctx.tenantId}:${me}`,
        MARKET_SEARCH_RATE.limit,
        MARKET_SEARCH_RATE.windowSeconds,
      );
    const fields: FieldError[] = [];
    if (
      q.minPrice !== undefined &&
      q.maxPrice !== undefined &&
      new Prisma.Decimal(q.minPrice).gt(new Prisma.Decimal(q.maxPrice))
    )
      fields.push({ field: 'maxPrice', code: FieldErrorCode.INVALID_VALUE });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const now = await dbNow(tx);
      const where: Prisma.Sql[] = [
        Prisma.sql`status = 'live'`,
        Prisma.sql`expires_at > ${now}`,
      ];
      if (words !== null)
        where.push(Prisma.sql`search @@ plainto_tsquery('simple', ${words})`);
      if (q.kind) where.push(Prisma.sql`kind = ${q.kind}::market_listing_kind`);
      if (q.category)
        where.push(
          Prisma.sql`category = ${q.category}::market_listing_category`,
        );
      if (q.minPrice !== undefined)
        where.push(Prisma.sql`price >= ${q.minPrice}::numeric`);
      if (q.maxPrice !== undefined)
        where.push(Prisma.sql`price <= ${q.maxPrice}::numeric`);
      let order: Prisma.Sql;
      if (sort === 'newest') {
        if (q.cursor) {
          const after = PAGE.decode(q.cursor);
          where.push(
            Prisma.sql`(created_at, id) < (${after.at}, ${after.id}::uuid)`,
          );
        }
        order = Prisma.sql`created_at DESC, id DESC`;
      } else {
        where.push(Prisma.sql`price IS NOT NULL`);
        const asc = sort === 'price_asc';
        if (q.cursor) {
          const after = decodePriceCursor(q.cursor);
          where.push(
            asc
              ? Prisma.sql`(price, id) > (${after.price}::numeric, ${after.id}::uuid)`
              : Prisma.sql`(price, id) < (${after.price}::numeric, ${after.id}::uuid)`,
          );
        }
        order = asc
          ? Prisma.sql`price ASC, id ASC`
          : Prisma.sql`price DESC, id DESC`;
      }
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM market_listings
         WHERE ${Prisma.join(where, ' AND ')}
         ORDER BY ${order}
         LIMIT ${limit + 1}`;
      const byId = new Map(
        (
          await tx.marketListing.findMany({
            where: { id: { in: ids.map((r) => r.id) } },
          })
        ).map((l) => [l.id, l]),
      );
      const rows = ids
        .map((r) => byId.get(r.id))
        .filter((l): l is MarketListing => l !== undefined);
      const more = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      const nextCursor =
        more && last
          ? sort === 'newest'
            ? PAGE.encode(last)
            : encodePriceCursor(last.price!, last.id)
          : null;
      return { items: await this.readAll(tx, items, now), nextCursor };
    });
  }

  /** A live listing, or the caller's own in any state; otherwise not found. */
  get(id: string): Promise<ListingRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const l = await tx.marketListing.findUnique({ where: { id } });
      const now = await dbNow(tx);
      if (!l || (l.sellerId !== this.ctx.accountId && !onMarketNow(l, now)))
        throw listingNotFound();
      return this.read(tx, l, now);
    });
  }

  /**
   * A listing on the market now, read in the caller's transaction (a
   * conversation starting on it): the one not-found otherwise.
   */
  async seen(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<MarketListing> {
    const l = await tx.marketListing.findUnique({ where: { id } });
    if (!l || !onMarketNow(l, now)) throw listingNotFound();
    return l;
  }

  // --------------------------------------------------------------------------
  // The handlers
  // --------------------------------------------------------------------------

  /** What waits for a handler: new or changed listings, and reported ones. */
  queue(q: StaffQueueQuery): Promise<Page<StaffListingRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.marketListing.findMany({
        where: {
          AND: [
            {
              status: q.status
                ? q.status
                : { in: ['pending_review', 'under_review'] },
            },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const now = await dbNow(tx);
      const items: StaffListingRead[] = [];
      for (const l of page.items) items.push(await this.staffRead(tx, l, now));
      return { items, nextCursor: page.nextCursor };
    });
  }

  /** Any listing of the compound, as the handlers read it. */
  staffGet(id: string): Promise<StaffListingRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const l = await tx.marketListing.findUnique({ where: { id } });
      if (!l) throw listingNotFound();
      return this.staffRead(tx, l, await dbNow(tx));
    });
  }

  /**
   * A handler lets a waiting listing on the market, or a reported one back
   * on. A new one gets its full days from now; a reported one keeps its day.
   */
  approve(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const l = await this.lock(tx, id);
      const now = await dbNow(tx);
      const state = stateOf(l, now);
      if (state !== 'pending_review' && state !== 'under_review')
        throw notPending(state);
      const settings = await this.settings.share(tx);
      await tx.marketListing.update({
        where: { id },
        data: {
          status: 'live',
          decidedAt: now,
          decidedById: this.ctx.accountId,
          expiresAt:
            state === 'pending_review'
              ? expiryFrom(now, settings.expiryDays)
              : undefined,
          expiryNotifiedAt: state === 'pending_review' ? null : undefined,
        },
      });
      await this.audit.record(tx, {
        action: 'market_listing.approved',
        targetId: id,
        metadata: { from: state },
      });
      await this.tell(tx, l, 'market_listing.approved', {});
    });
  }

  /** A handler turns a waiting listing down, with a code. */
  reject(id: string, reasonCode: string | undefined): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.marketListingReject,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const l = await this.lock(tx, id);
      const now = await dbNow(tx);
      const state = stateOf(l, now);
      if (state !== 'pending_review') throw notPending(state);
      await this.end(tx, l, 'rejected', code, now, this.ctx.accountId);
      await this.audit.record(tx, {
        action: 'market_listing.rejected',
        targetId: id,
        metadata: { reasonCode: code },
      });
      await this.tell(tx, l, 'market_listing.rejected', { reason: code });
    });
  }

  /** A handler takes a live or reported listing off the market, with a code. */
  remove(id: string, reasonCode: string | undefined): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.marketListingRemove,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const l = await this.lock(tx, id);
      const now = await dbNow(tx);
      const state = stateOf(l, now);
      if (state !== 'live' && state !== 'under_review') {
        if (ENDED_STATUSES.includes(state)) throw ended(state);
        throw notPending(state);
      }
      await this.removeLocked(tx, l, code, now);
    });
  }

  /** Removal under the listing's lock, the caller's decision (a report's too). */
  async removeLocked(
    tx: TenantTxClient,
    l: MarketListing,
    code: string,
    now: Date,
  ): Promise<void> {
    await this.end(tx, l, 'removed', code, now, this.ctx.accountId);
    await this.audit.record(tx, {
      action: 'market_listing.removed',
      targetId: l.id,
      metadata: { reasonCode: code },
    });
    await this.tell(tx, l, 'market_listing.removed', { reason: code });
  }

  // --------------------------------------------------------------------------
  // Shared
  // --------------------------------------------------------------------------

  /** The listing's row, FOR UPDATE; the one not-found when unknown. */
  async lock(tx: TenantTxClient, id: string): Promise<MarketListing> {
    await tx.$queryRaw`SELECT id FROM market_listings WHERE id = ${id}::uuid FOR UPDATE`;
    const l = await tx.marketListing.findUnique({ where: { id } });
    if (!l) throw listingNotFound();
    return l;
  }

  /** The caller's own listing, FOR UPDATE; anyone else's is not found. */
  private async lockMine(
    tx: TenantTxClient,
    id: string,
  ): Promise<MarketListing> {
    const l = await this.lock(tx, id);
    if (l.sellerId !== this.ctx.accountId) throw listingNotFound();
    return l;
  }

  /**
   * Ends a listing under its lock: its status, the end's code and time,
   * and the handler's decision when a handler ended it.
   */
  async end(
    tx: TenantTxClient,
    l: MarketListing,
    status: 'rejected' | 'removed' | 'withdrawn' | 'sold' | 'expired',
    reasonCode: string | null,
    now: Date,
    decidedBy?: string,
  ): Promise<void> {
    await tx.marketListing.update({
      where: { id: l.id },
      data: {
        status,
        reasonCode,
        endedAt: now,
        ...(decidedBy ? { decidedAt: now, decidedById: decidedBy } : {}),
      },
    });
  }

  /** The system withdraws a listing (its seller left, was erased, or no longer owns the unit). */
  async withdrawBySystem(
    tx: TenantTxClient,
    l: MarketListing,
    reason: SystemWithdrawal,
    now: Date,
  ): Promise<void> {
    await this.end(tx, l, 'withdrawn', reason, now);
    await this.audit.record(tx, {
      action: 'market_listing.withdrawn',
      targetId: l.id,
      metadata: { kind: l.kind, by: 'system', reasonCode: reason },
    });
  }

  /** Open, by the reader's clock: waiting, reported, or live with days left. */
  openWhere(now: Date): Prisma.MarketListingWhereInput {
    return {
      OR: [
        { status: { in: ['pending_review', 'under_review'] } },
        liveWhere(now),
      ],
    };
  }

  /**
   * The unit has no open listing of this kind. One whose day passed but
   * was never swept is marked expired here, under the unit's lock, so the
   * owner may list again at once.
   */
  private async assertUnitFree(
    tx: TenantTxClient,
    unitId: string,
    kind: MarketListingKind,
  ): Promise<void> {
    const open = await tx.marketListing.findFirst({
      where: { unitId, kind, status: { in: [...OPEN_STATUSES] } },
    });
    if (!open) return;
    const now = await dbNow(tx);
    if (stateOf(open, now) === 'expired') {
      const l = await this.lock(tx, open.id);
      if (stateOf(l, now) === 'expired') {
        await this.end(tx, l, 'expired', null, now);
        await this.audit.record(tx, {
          action: 'market_listing.expired',
          targetId: l.id,
          metadata: { kind: l.kind },
        });
        return;
      }
    }
    throw appError.conflict(
      ErrorCode.MARKET_UNIT_LISTED,
      'The unit is listed for this already',
      { params: { listingId: open.id } },
    );
  }

  /** The seller, if still active: the listing's kind and the given params. */
  async tell(
    tx: TenantTxClient,
    l: Pick<MarketListing, 'id' | 'kind' | 'sellerId'>,
    kind: NotificationKind,
    params: Record<string, string>,
  ): Promise<void> {
    const active = await tx.account.count({
      where: { id: l.sellerId, status: 'active' },
    });
    if (!active) return;
    await this.notifier.notify(tx, [l.sellerId], {
      kind,
      params: { listingKind: l.kind, ...params },
      targetId: l.id,
    });
  }

  private text(input: NewListing): { title: string; body: string } {
    const title = input.title.trim();
    const body = input.body.trim();
    const fields: FieldError[] = [];
    if (!within(title, LISTING_TITLE_LENGTH))
      fields.push(lengthError('title', LISTING_TITLE_LENGTH));
    if (!within(body, LISTING_BODY_LENGTH))
      fields.push(lengthError('body', LISTING_BODY_LENGTH));
    if (fields.length) throw invalid(fields);
    return { title, body };
  }

  /** The price as the kind wants it: FIELD_REQUIRED or FIELD_NOT_ALLOWED. */
  private price(
    kind: MarketListingKind,
    price: string | null,
    field = 'price',
  ): Prisma.Decimal | null {
    const problem = priceProblem(kind, price);
    if (problem === 'required')
      throw invalid([{ field, code: FieldErrorCode.FIELD_REQUIRED }]);
    if (problem === 'not_allowed')
      throw invalid([{ field, code: FieldErrorCode.FIELD_NOT_ALLOWED }]);
    return price === null ? null : new Prisma.Decimal(price);
  }

  /** A unit kind names its unit and is real estate; nothing else does. */
  private unitShape(input: NewListing): void {
    const fields: FieldError[] = [];
    const unit = isUnitKind(input.kind);
    if (unit && !input.unitId)
      fields.push({ field: 'unitId', code: FieldErrorCode.FIELD_REQUIRED });
    if (!unit && input.unitId)
      fields.push({ field: 'unitId', code: FieldErrorCode.FIELD_NOT_ALLOWED });
    if (unit && input.fromUnitId)
      fields.push({
        field: 'fromUnitId',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if ((input.category === 'real_estate') !== unit)
      fields.push({ field: 'category', code: FieldErrorCode.INVALID_VALUE });
    if (fields.length) throw invalid(fields);
  }

  /** At most MAX_LISTING_PHOTOS, each once. */
  private photoIds(ids: readonly string[] | undefined): string[] {
    const unique = [...new Set(ids ?? [])];
    if (unique.length > MAX_LISTING_PHOTOS)
      throw invalid([
        {
          field: 'photoFileIds',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 0, max: MAX_LISTING_PHOTOS },
        },
      ]);
    return unique;
  }

  async read(
    tx: TenantTxClient,
    l: MarketListing,
    now: Date,
  ): Promise<ListingRead> {
    return (await this.readAll(tx, [l], now))[0];
  }

  /** Each listing with its photos, its seller's building and its unit's facts. */
  async readAll(
    tx: TenantTxClient,
    rows: readonly MarketListing[],
    now: Date,
  ): Promise<ListingRead[]> {
    if (!rows.length) return [];
    const me = this.ctx.accountId;
    const units = await this.community.units(
      tx,
      rows.map((l) => l.sellerUnitId),
    );
    const facts = await this.community.unitFacts(
      tx,
      rows.flatMap((l) => (l.unitId ? [l.unitId] : [])),
    );
    const photos = await tx.marketListingPhoto.findMany({
      where: { listingId: { in: rows.map((l) => l.id) } },
      include: { file: { select: { contentType: true } } },
      orderBy: [{ listingId: 'asc' }, { position: 'asc' }],
    });
    const out: ListingRead[] = [];
    for (const l of rows) {
      const own: PhotoRead[] = [];
      for (const p of photos.filter((x) => x.listingId === l.id))
        own.push({
          id: p.id,
          contentType: p.file.contentType,
          read: await this.files.readUrl(tx, p.fileId),
        });
      out.push({
        listing: l,
        state: stateOf(l, now),
        photos: own,
        building: units.get(l.sellerUnitId)?.building ?? null,
        mine: l.sellerId === me,
        unit: l.unitId ? (facts.get(l.unitId) ?? null) : null,
      });
    }
    return out;
  }

  private async staffRead(
    tx: TenantTxClient,
    l: MarketListing,
    now: Date,
  ): Promise<StaffListingRead> {
    const base = await this.read(tx, l, now);
    const seller = await tx.account.findUniqueOrThrow({
      where: { id: l.sellerId },
      select: { id: true, fullName: true, status: true },
    });
    const units = await this.community.units(
      tx,
      l.unitId ? [l.sellerUnitId, l.unitId] : [l.sellerUnitId],
    );
    return {
      ...base,
      seller,
      sellerUnitCode: units.get(l.sellerUnitId)?.code ?? null,
      unitCode: l.unitId ? (units.get(l.unitId)?.code ?? null) : null,
    };
  }
}

const within = (text: string, range: { min: number; max: number }) =>
  text.length >= range.min && text.length <= range.max;

const lengthError = (
  field: string,
  range: { min: number; max: number },
): FieldError => ({
  field,
  code: FieldErrorCode.INVALID_LENGTH,
  params: { ...range },
});

const sameMoney = (
  a: Prisma.Decimal | null,
  b: Prisma.Decimal | null,
): boolean => (a === null || b === null ? a === b : a.equals(b));

/** On the market by the reader's clock (live, its day ahead). */
const onMarketNow = (l: MarketListing, now: Date): boolean =>
  stateOf(l, now) === 'live';
