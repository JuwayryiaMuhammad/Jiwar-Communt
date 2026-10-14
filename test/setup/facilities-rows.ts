import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

/**
 * Raw rows of the facilities tables (ADR 0044), written straight through
 * the tenant client: for the database-level suites (RLS isolation, schema),
 * which test what the tables refuse whatever the services would do.
 */

/** A bookable facility: a court, one booking per hour. */
export async function facilityRow(
  tx: TenantTxClient,
  tenantId: string,
  over: { mode?: 'bookable' | 'walk_in' } = {},
): Promise<string> {
  const id = newId();
  const bookable = (over.mode ?? 'bookable') === 'bookable';
  await tx.facility.create({
    data: {
      id,
      tenantId,
      mode: bookable ? 'bookable' : 'walk_in',
      nameEn: 'Court',
      nameAr: 'ملعب',
      ...(bookable
        ? {
            slotMinutes: 60,
            capacity: 1,
            capacityUnit: 'bookings',
            maxDaysAhead: 14,
            minMinutesBefore: 60,
            cancelCutoffMinutes: 120,
            maxGuests: 0,
            weeklyQuota: 2,
            peakQuota: 1,
          }
        : {}),
    },
  });
  return id;
}

/** A weekly window of a facility: its hours, or (`peak`) a peak time. */
export async function facilityWindowRow(
  tx: TenantTxClient,
  input: { tenantId: string; facilityId: string; peak?: boolean },
): Promise<string> {
  const id = newId();
  const data = {
    id,
    tenantId: input.tenantId,
    facilityId: input.facilityId,
    weekday: 1,
    startMinute: 540,
    endMinute: 600,
  };
  if (input.peak) await tx.facilityPeakWindow.create({ data });
  else await tx.facilityHours.create({ data });
  return id;
}
