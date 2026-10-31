import type { FilePurpose, MarketListingStatus } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { dbClock } from './compound-clock';

const DAY = 86_400_000;

/**
 * Rows of the community phase (ADR 0071), written straight into the
 * tables for the schema suites and the API world: no service, no audit.
 */

/** A finalized, attached file of a purpose. */
export async function marketFileRow(
  tx: TenantTxClient,
  tenantId: string,
  purpose: FilePurpose = 'market_listing_photo',
): Promise<string> {
  const id = newId();
  const now = dbClock();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose,
      contentType: 'image/png',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}

/** A listing to sell, live for 30 days unless told otherwise. */
export async function listingRow(
  tx: TenantTxClient,
  row: {
    tenantId: string;
    sellerId: string;
    sellerUnitId: string;
    status?: MarketListingStatus;
    title?: string;
  },
): Promise<string> {
  const id = newId();
  const now = dbClock();
  const status = row.status ?? 'live';
  const ended = ['rejected', 'removed', 'withdrawn', 'sold', 'expired'];
  await tx.marketListing.create({
    data: {
      id,
      tenantId: row.tenantId,
      kind: 'sell',
      category: 'furniture',
      sellerId: row.sellerId,
      sellerUnitId: row.sellerUnitId,
      title: row.title ?? 'A chair',
      body: 'A wooden chair.',
      price: '100',
      status,
      expiresAt: new Date(now.getTime() + 30 * DAY),
      endedAt: ended.includes(status) ? now : null,
      createdAt: now,
    },
  });
  return id;
}

/** An open shop, active unless told otherwise. */
export async function shopRow(
  tx: TenantTxClient,
  row: {
    tenantId: string;
    ownerId: string;
    ownerUnitId: string;
    status?: 'pending' | 'active';
  },
): Promise<string> {
  const id = newId();
  await tx.marketShop.create({
    data: {
      id,
      tenantId: row.tenantId,
      ownerId: row.ownerId,
      ownerUnitId: row.ownerUnitId,
      nameEn: 'Home bakery',
      nameAr: 'مخبز منزلي',
      description: 'Bread on Fridays.',
      category: 'food',
      status: row.status ?? 'active',
      createdAt: dbClock(),
    },
  });
  return id;
}

/** An open report of a listing. */
export async function marketReportRow(
  tx: TenantTxClient,
  row: {
    tenantId: string;
    listingId: string;
    reporterId: string;
    reporterUnitId: string;
  },
): Promise<string> {
  const id = newId();
  await tx.marketListingReport.create({
    data: {
      id,
      tenantId: row.tenantId,
      listingId: row.listingId,
      reporterId: row.reporterId,
      reporterUnitId: row.reporterUnitId,
      reasonCode: 'other',
      createdAt: dbClock(),
    },
  });
  return id;
}

/** An offer of a partner, in force today. */
export async function partnerOfferRow(
  tx: TenantTxClient,
  row: { tenantId: string; partnerId: string; createdById: string },
): Promise<string> {
  const id = newId();
  const now = dbClock();
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  await tx.partnerOffer.create({
    data: {
      id,
      tenantId: row.tenantId,
      partnerId: row.partnerId,
      titleEn: 'An offer',
      titleAr: 'عرض',
      bodyEn: 'Ten percent off.',
      bodyAr: 'خصم عشرة بالمئة.',
      validFromOn: today,
      validToOn: today,
      createdById: row.createdById,
      createdAt: now,
    },
  });
  return id;
}
