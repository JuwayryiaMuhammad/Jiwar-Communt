import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { MarketListing } from '@prisma/client';
import { CommunityNeighboursPort } from '../../community';
import {
  AccountLifecycle,
  type AfterCommit,
} from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { ListingsService } from './listings.service';
import { ShopsService } from './shops.service';
import { EXPIRY_NOTICE_MS, OPEN_STATUSES, stateOf } from './market-rules';

export const MARKET_LISTINGS_SWEEP = 'market.listings';
const BATCH = 500;

/**
 * The market's lifecycle (ADR 0071), each step in the transaction that
 * causes it, every listing under its own lock:
 *
 * - `market.listings` (hourly): a live listing whose day passed expires;
 *   one within two days of it tells its seller once.
 * - Leaving: someone with no place left in the compound is no longer on
 *   its market, and their open listings are withdrawn (`seller_left`). An
 *   owner whose ownership of a listed unit ended loses that listing
 *   (`owner_left`), wherever else they live.
 * - Erasure: their open listings are withdrawn (`seller_erased`), the
 *   words of every listing of theirs go, and their photos with their files;
 *   their shop closes (`owner_erased`) and its words go. The rows stay,
 *   pointing at the tombstone. Leaving closes their shop (`owner_left`).
 */
@Injectable()
export class MarketLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityNeighboursPort,
    private readonly listings: ListingsService,
    private readonly shops: ShopsService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing((tx, account) => this.erase(tx, account.id));
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      const now = await dbNow(tx);
      const left = !(await this.community.places(tx, account.id)).length;
      if (left) await this.closeShop(tx, account.id, 'owner_left', now);
      for (const l of await this.openOf(tx, account.id)) {
        if (left) {
          await this.withdraw(tx, l.id, 'seller_left', now);
          continue;
        }
        if (
          l.unitId &&
          !(await this.community.ownsLive(tx, account.id, l.unitId))
        )
          await this.withdraw(tx, l.id, 'owner_left', now);
      }
    });
    this.sweep.register(MARKET_LISTINGS_SWEEP, (now) => this.run(now), {
      intervalMs: 3_600_000,
    });
  }

  /** Expired listings marked, then the sellers told of those ending soon. */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const due = await tx.marketListing.findMany({
          where: {
            status: 'live',
            OR: [
              { expiresAt: { lte: now } },
              {
                expiresAt: { lte: new Date(now.getTime() + EXPIRY_NOTICE_MS) },
                expiryNotifiedAt: null,
              },
            ],
          },
          select: { id: true },
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        return due.map((d) => d.id);
      },
      (tx, _tenantId, id) => this.one(tx, id),
    );
  }

  /** One listing, judged again under its lock on the database's clock. */
  private async one(tx: TenantTxClient, id: string): Promise<number> {
    const l = await this.listings.lock(tx, id);
    const now = await dbNow(tx);
    if (l.status !== 'live') return 0;
    if (stateOf(l, now) === 'expired') {
      await this.listings.end(tx, l, 'expired', null, now);
      await this.audit.record(tx, {
        action: 'market_listing.expired',
        targetId: id,
        metadata: { kind: l.kind },
      });
      return 1;
    }
    if (
      l.expiryNotifiedAt === null &&
      l.expiresAt.getTime() - now.getTime() <= EXPIRY_NOTICE_MS
    ) {
      await tx.marketListing.update({
        where: { id },
        data: { expiryNotifiedAt: now },
      });
      await this.listings.tell(tx, l, 'market_listing.expiring', {});
      return 1;
    }
    return 0;
  }

  /** The account's open listings, locked in id order. */
  private async openOf(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<MarketListing[]> {
    const rows = await tx.marketListing.findMany({
      where: { sellerId: accountId, status: { in: [...OPEN_STATUSES] } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const out: MarketListing[] = [];
    for (const { id } of rows) out.push(await this.listings.lock(tx, id));
    return out;
  }

  /** The account's open shop closes, by the system, with the reason. */
  private async closeShop(
    tx: TenantTxClient,
    accountId: string,
    reason: 'owner_left' | 'owner_erased',
    now: Date,
  ): Promise<void> {
    const open = await tx.marketShop.findFirst({
      where: { ownerId: accountId, status: { not: 'closed' } },
      select: { id: true },
    });
    if (!open) return;
    const shop = await this.shops.lock(tx, open.id);
    if (shop.status === 'closed') return;
    await this.shops.closeLocked(tx, shop, reason, now);
    await this.audit.record(tx, {
      action: 'market_shop.closed',
      targetId: shop.id,
      metadata: { by: 'system', reasonCode: reason },
    });
  }

  private async withdraw(
    tx: TenantTxClient,
    id: string,
    reason: 'seller_left' | 'seller_erased' | 'owner_left',
    now: Date,
  ): Promise<void> {
    const l = await this.listings.lock(tx, id);
    if (!(OPEN_STATUSES as readonly string[]).includes(l.status)) return;
    await this.listings.withdrawBySystem(tx, l, reason, now);
  }

  private async erase(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<AfterCommit[]> {
    const now = await dbNow(tx);
    await this.closeShop(tx, accountId, 'owner_erased', now);
    for (const l of await this.openOf(tx, accountId))
      await this.withdraw(tx, l.id, 'seller_erased', now);
    await tx.$executeRaw`
      UPDATE market_shops
         SET name_en = NULL, name_ar = NULL, description = NULL,
             erased_at = ${now}, updated_at = ${now}
       WHERE owner_account_id = ${accountId}::uuid AND erased_at IS NULL`;
    await tx.$executeRaw`
      UPDATE market_listings
         SET title = NULL, body = NULL, erased_at = ${now}, updated_at = ${now}
       WHERE seller_account_id = ${accountId}::uuid AND erased_at IS NULL`;
    // The photos: each file marked deleted and its row gone with it, now;
    // the objects and the file rows after the commit.
    const photos = await tx.marketListingPhoto.findMany({
      where: { listing: { sellerId: accountId } },
      select: { id: true, fileId: true },
      orderBy: { fileId: 'asc' },
    });
    for (const p of photos)
      await this.files.markDeleted(
        tx,
        { id: p.fileId, purpose: 'market_listing_photo' },
        'erasure',
      );
    if (photos.length)
      await tx.marketListingPhoto.deleteMany({
        where: { id: { in: photos.map((p) => p.id) } },
      });
    return photos.map((p) => async () => {
      await this.files.purge(p.fileId);
    });
  }
}
