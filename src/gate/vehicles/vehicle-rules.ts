import type { VehicleStatus } from '@prisma/client';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';

export const MAKE_AND_MODEL = { min: 1, max: 60 } as const;
export const COLOR = { min: 1, max: 30 } as const;

/** A permit is `expires_soon` within this many days of its last day. */
export const EXPIRING_DAYS = 30;
/** A permit is valid for at most this many days from today. */
export const MAX_PERMIT_DAYS = 731;
/** A removed vehicle's licence photo is deleted this long after. */
export const LICENCE_PHOTO_RETENTION_DAYS = 30;

/**
 * What residents, the staff and the guard read of a vehicle's permit
 * (ADR 0045). `expires_soon` and `expired` are read from the last local day
 * the permit is valid, against the compound's today; never stored.
 */
export type PermitStatus =
  'pending' | 'active' | 'expires_soon' | 'expired' | 'rejected' | 'removed';

export const PERMIT_STATUSES: readonly PermitStatus[] = [
  'pending',
  'active',
  'expires_soon',
  'expired',
  'rejected',
  'removed',
];

export function permitStatus(
  status: VehicleStatus,
  validUntil: LocalDate | null,
  today: LocalDate,
): PermitStatus {
  if (status !== 'active') return status;
  if (!validUntil || validUntil < today) return 'expired';
  return validUntil <= addDays(today, EXPIRING_DAYS)
    ? 'expires_soon'
    : 'active';
}

/** A record's number as people say it: `V-0042`, `P-8741`, `F-12345`. */
export function reference(prefix: 'V' | 'P' | 'F' | 'R', n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

export const STICKER = /^[A-Z0-9-]{1,20}$/;

/** A sticker number as stored: trimmed, upper case; null when it is not one. */
export function normalizeSticker(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  return STICKER.test(s) ? s : null;
}

/** A Date column of type DATE as the local day it holds. */
export const dayOf = (d: Date | null): LocalDate | null =>
  d ? d.toISOString().slice(0, 10) : null;

/** A local day as the Date a DATE column takes. */
export const asDate = (d: LocalDate): Date => new Date(`${d}T00:00:00.000Z`);
