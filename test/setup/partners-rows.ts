import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

/**
 * Raw rows of the partners tables (ADR 0060), written straight through the
 * tenant client: for the database-level suites (RLS isolation, schema),
 * which test what the tables refuse whatever the services would do.
 */

/** A sub-category under `home_services`, with a fresh key. */
export async function subcategoryRow(
  tx: TenantTxClient,
  tenantId: string,
  category = 'home_services',
): Promise<string> {
  const id = newId();
  await tx.partnerSubcategory.create({
    data: {
      id,
      tenantId,
      category,
      key: `k_${id.replace(/-/g, '').slice(-12)}`,
      nameEn: 'Cleaning',
      nameAr: 'تنظيف',
    },
  });
  return id;
}

/** An active partner, created by `createdById`. */
export async function partnerRow(
  tx: TenantTxClient,
  input: { tenantId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.partner.create({
    data: {
      id,
      tenantId: input.tenantId,
      nameEn: 'Clean Co',
      nameAr: 'كلين',
      businessPhone: '+20225550100',
      listedAt: new Date(),
      createdById: input.createdById,
    },
  });
  return id;
}

/** What a partner does: a category and (optionally) a sub-category. */
export async function partnerServiceRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    partnerId: string;
    category?: string;
    subcategoryId?: string | null;
  },
): Promise<string> {
  const id = newId();
  await tx.partnerService.create({
    data: {
      id,
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      category: input.category ?? 'home_services',
      subcategoryId: input.subcategoryId ?? null,
    },
  });
  return id;
}

/** A weekly window of a partner, Monday 09:00–10:00. */
export async function partnerHoursRow(
  tx: TenantTxClient,
  input: { tenantId: string; partnerId: string },
): Promise<string> {
  const id = newId();
  await tx.partnerHours.create({
    data: {
      id,
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      weekday: 1,
      startMinute: 540,
      endMinute: 600,
    },
  });
  return id;
}

/** A price line: a visit fee of 150 EGP. */
export async function priceItemRow(
  tx: TenantTxClient,
  input: { tenantId: string; partnerId: string; subcategoryId?: string },
): Promise<string> {
  const id = newId();
  await tx.partnerPriceItem.create({
    data: {
      id,
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      subcategoryId: input.subcategoryId ?? null,
      nameEn: 'Visit',
      nameAr: 'زيارة',
      price: '150.00',
      unit: 'visit_fee',
      position: 0,
    },
  });
  return id;
}

/** A partner among an account's favourites. */
export async function favouriteRow(
  tx: TenantTxClient,
  input: { tenantId: string; accountId: string; partnerId: string },
): Promise<string> {
  await tx.partnerFavourite.create({
    data: { ...input, createdAt: new Date() },
  });
  return input.partnerId;
}
