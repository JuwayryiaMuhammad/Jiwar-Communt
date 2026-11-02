import { Injectable } from '@nestjs/common';
import type {
  MarketListingCategory,
  MarketShop,
  MarketShopStatus,
} from '@prisma/client';
import { CommunityNeighboursPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { NeighbourAccess } from '../access';
import { dbNow } from '../db-clock';
import { liveWhere } from './market-rules';
import {
  categoryAllowed,
  MarketSettingsService,
} from './market-settings.service';

export const SHOP_NAME_LENGTH = { min: 2, max: 60 } as const;
export const SHOP_DESCRIPTION_LENGTH = { min: 1, max: 500 } as const;

export interface NewShop {
  nameEn: string;
  nameAr: string;
  description: string;
  category: MarketListingCategory;
  /** One of the caller's own units to run it from, when they have several. */
  fromUnitId?: string;
}

/** A shop as a resident reads it: the building it is run from, no person. */
export interface ShopRead {
  shop: MarketShop;
  building: string | null;
  mine: boolean;
  /** Its listings on the market now. */
  liveListings: number;
}

export interface StaffShopRead extends ShopRead {
  owner: { id: string; fullName: string | null; status: string };
  ownerUnitCode: string | null;
}

const PAGE = keysetCursor('createdAt');

export const shopNotFound = () =>
  appError.notFound(ErrorCode.MARKET_SHOP_NOT_FOUND, 'Shop not found');

const wrongState = (status: MarketShopStatus) =>
  appError.conflict(
    ErrorCode.MARKET_SHOP_STATE,
    'The shop is not in a state this starts from',
    { params: { status } },
  );

/**
 * A resident's small shop (ADR 0071): one open an account, run from one of
 * their units. A handler lets it open, turns it down (it closes) or
 * suspends it with a code, and reinstates it; its owner closes it. A shop
 * names no person: readers see its building.
 *
 * Locks: the caller's account row; the caller's quota (opening); the
 * shop's row (FOR UPDATE).
 */
@Injectable()
export class ShopsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly self: NeighbourAccess,
    private readonly community: CommunityNeighboursPort,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly settings: MarketSettingsService,
  ) {}

  /** A resident opens a shop: it waits for a handler. */
  open(input: NewShop): Promise<MarketShop> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      await this.self.lockQuota(tx, me);
      const places = await this.community.places(tx, me);
      if (!places.length)
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only someone with a unit in the compound opens a shop',
        );
      if (input.fromUnitId && !places.some((p) => p.id === input.fromUnitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const open = await tx.marketShop.findFirst({
        where: { ownerId: me, status: { not: 'closed' } },
        select: { id: true },
      });
      if (open)
        throw appError.conflict(
          ErrorCode.MARKET_SHOP_EXISTS,
          'You have a shop already',
          { params: { shopId: open.id } },
        );
      // The compound's rules (ADR 0083): a shop is commercial, and its
      // category must be one the market takes now. The settings row last.
      const settings = await this.settings.share(tx);
      if (settings.commercialBlocked)
        throw appError.conflict(
          ErrorCode.MARKET_COMMERCIAL_BLOCKED,
          'The compound takes no commercial listings now',
        );
      if (!categoryAllowed(settings, input.category))
        throw appError.conflict(
          ErrorCode.MARKET_CATEGORY_NOT_ALLOWED,
          'The compound does not take this category now',
          { params: { category: input.category } },
        );
      const now = await dbNow(tx);
      const shop = await tx.marketShop.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          ownerId: me,
          ownerUnitId: input.fromUnitId ?? places[0].id,
          nameEn: input.nameEn.trim(),
          nameAr: input.nameAr.trim(),
          description: input.description.trim(),
          category: input.category,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'market_shop.opened',
        targetId: shop.id,
        metadata: { category: shop.category },
      });
      return shop;
    });
  }

  /** The active shops, newest first. */
  list(q: { cursor?: string; limit?: number }): Promise<Page<ShopRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.marketShop.findMany({
        where: { AND: [{ status: 'active' }, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.readAll(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** An active shop, or the caller's own in any state. */
  get(id: string): Promise<ShopRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const shop = await tx.marketShop.findUnique({ where: { id } });
      if (
        !shop ||
        (shop.status !== 'active' && shop.ownerId !== this.ctx.accountId)
      )
        throw shopNotFound();
      return (await this.readAll(tx, [shop]))[0];
    });
  }

  /** The caller's open shop, or the last they had. */
  mine(): Promise<ShopRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const shop = await tx.marketShop.findFirst({
        where: { ownerId: this.ctx.accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (!shop) throw shopNotFound();
      return (await this.readAll(tx, [shop]))[0];
    });
  }

  /** Every shop the caller opened, oldest first: their export (ADR 0036). */
  everyOwn(): Promise<ShopRead[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.readAll(
        tx,
        await tx.marketShop.findMany({
          where: { ownerId: this.ctx.accountId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ),
    );
  }

  /** The owner closes their shop; its listings stay as they are. */
  close(): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const found = await tx.marketShop.findFirst({
        where: { ownerId: this.ctx.accountId, status: { not: 'closed' } },
        select: { id: true },
      });
      if (!found) throw shopNotFound();
      const shop = await this.lock(tx, found.id);
      if (shop.status === 'closed') throw wrongState(shop.status);
      await this.closeLocked(tx, shop, null, await dbNow(tx));
      await this.audit.record(tx, {
        action: 'market_shop.closed',
        targetId: shop.id,
        metadata: { by: 'owner' },
      });
    });
  }

  /**
   * The caller's active shop, for a listing to appear under: anything
   * else answers as a shop not there.
   */
  async activeOf(tx: TenantTxClient, shopId: string): Promise<MarketShop> {
    const shop = await tx.marketShop.findUnique({ where: { id: shopId } });
    if (
      !shop ||
      shop.ownerId !== this.ctx.accountId ||
      shop.status !== 'active'
    )
      throw shopNotFound();
    return shop;
  }

  // --------------------------------------------------------------------------
  // The handlers
  // --------------------------------------------------------------------------

  staffList(q: {
    cursor?: string;
    limit?: number;
    status?: MarketShopStatus;
  }): Promise<Page<StaffShopRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.marketShop.findMany({
        where: {
          AND: [q.status ? { status: q.status } : {}, ...PAGE.after(q.cursor)],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: StaffShopRead[] = [];
      for (const shop of page.items) items.push(await this.staffRead(tx, shop));
      return { items, nextCursor: page.nextCursor };
    });
  }

  /** A waiting shop opens, or a suspended one reopens. */
  approve(id: string): Promise<void> {
    return this.decide(id, async (tx, shop, now) => {
      if (shop.status !== 'pending' && shop.status !== 'suspended')
        throw wrongState(shop.status);
      await tx.marketShop.update({
        where: { id },
        data: {
          status: 'active',
          reasonCode: null,
          decidedAt: now,
          decidedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action:
          shop.status === 'pending'
            ? 'market_shop.approved'
            : 'market_shop.reinstated',
        targetId: id,
      });
      await this.tell(tx, shop, 'market_shop.approved', {});
    });
  }

  /** A waiting shop is turned down: it closes with the code. */
  reject(id: string, reasonCode: string | undefined): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.marketShopReject,
    );
    return this.decide(id, async (tx, shop, now) => {
      if (shop.status !== 'pending') throw wrongState(shop.status);
      await this.closeLocked(tx, shop, code, now, this.ctx.accountId);
      await this.audit.record(tx, {
        action: 'market_shop.rejected',
        targetId: id,
        metadata: { reasonCode: code },
      });
      await this.tell(tx, shop, 'market_shop.rejected', { reason: code });
    });
  }

  /** An active shop is suspended with the code, until reinstated. */
  suspend(id: string, reasonCode: string | undefined): Promise<void> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.marketShopSuspend,
    );
    return this.decide(id, async (tx, shop, now) => {
      if (shop.status !== 'active') throw wrongState(shop.status);
      await tx.marketShop.update({
        where: { id },
        data: {
          status: 'suspended',
          reasonCode: code,
          decidedAt: now,
          decidedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'market_shop.suspended',
        targetId: id,
        metadata: { reasonCode: code },
      });
      await this.tell(tx, shop, 'market_shop.suspended', { reason: code });
    });
  }

  // --------------------------------------------------------------------------
  // Shared
  // --------------------------------------------------------------------------

  async lock(tx: TenantTxClient, id: string): Promise<MarketShop> {
    await tx.$queryRaw`SELECT id FROM market_shops WHERE id = ${id}::uuid FOR UPDATE`;
    const shop = await tx.marketShop.findUnique({ where: { id } });
    if (!shop) throw shopNotFound();
    return shop;
  }

  /** Closes a shop under its lock: its code, its handler when one decided. */
  async closeLocked(
    tx: TenantTxClient,
    shop: MarketShop,
    reasonCode: string | null,
    now: Date,
    decidedBy?: string,
  ): Promise<void> {
    await tx.marketShop.update({
      where: { id: shop.id },
      data: {
        status: 'closed',
        reasonCode,
        closedAt: now,
        ...(decidedBy ? { decidedAt: now, decidedById: decidedBy } : {}),
      },
    });
  }

  private decide(
    id: string,
    fn: (tx: TenantTxClient, shop: MarketShop, now: Date) => Promise<void>,
  ): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.self.lockSelf(tx);
      const shop = await this.lock(tx, id);
      await fn(tx, shop, await dbNow(tx));
    });
  }

  private async tell(
    tx: TenantTxClient,
    shop: MarketShop,
    kind: NotificationKind,
    params: Record<string, string>,
  ): Promise<void> {
    const active = await tx.account.count({
      where: { id: shop.ownerId, status: 'active' },
    });
    if (!active) return;
    await this.notifier.notify(tx, [shop.ownerId], {
      kind,
      params,
      targetId: shop.id,
    });
  }

  private async readAll(
    tx: TenantTxClient,
    shops: readonly MarketShop[],
  ): Promise<ShopRead[]> {
    if (!shops.length) return [];
    const now = await dbNow(tx);
    const units = await this.community.units(
      tx,
      shops.map((s) => s.ownerUnitId),
    );
    const counts = await tx.marketListing.groupBy({
      by: ['shopId'],
      where: { shopId: { in: shops.map((s) => s.id) }, ...liveWhere(now) },
      _count: { _all: true },
    });
    const live = new Map(counts.map((c) => [c.shopId, c._count._all]));
    return shops.map((shop) => ({
      shop,
      building: units.get(shop.ownerUnitId)?.building ?? null,
      mine: shop.ownerId === this.ctx.accountId,
      liveListings: live.get(shop.id) ?? 0,
    }));
  }

  private async staffRead(
    tx: TenantTxClient,
    shop: MarketShop,
  ): Promise<StaffShopRead> {
    const [base] = await this.readAll(tx, [shop]);
    const owner = await tx.account.findUniqueOrThrow({
      where: { id: shop.ownerId },
      select: { id: true, fullName: true, status: true },
    });
    const unit = await this.community.unit(tx, shop.ownerUnitId);
    return { ...base, owner, ownerUnitCode: unit?.code ?? null };
  }
}
