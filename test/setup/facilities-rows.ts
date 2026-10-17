import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { day, dbDate } from './compound-clock';

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

let bookingRows = 0;

/** A confirmed booking of a slot of the facility's, from tomorrow on, an hour each. */
export async function bookingRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    facilityId: string;
    unitId: string;
    bookedById: string;
  },
): Promise<string> {
  const id = newId();
  // A slot of its own each time: a unit holds one slot once.
  const startsAt = new Date(
    Math.ceil(Date.now() / 3_600_000) * 3_600_000 +
      86_400_000 +
      bookingRows++ * 3_600_000,
  );
  await tx.booking.create({
    data: {
      id,
      ...input,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      guests: 0,
      partySize: 1,
      peak: false,
      status: 'confirmed',
    },
  });
  return id;
}

/** A slot's lock row of the facility. */
export async function slotLockRow(
  tx: TenantTxClient,
  input: { tenantId: string; facilityId: string },
): Promise<string> {
  await tx.facilitySlotLock.create({
    data: { ...input, startsAt: new Date(Date.UTC(2031, 0, 1, 10)) },
  });
  return input.facilityId;
}

/** A closure of the facility, a month ahead. */
export async function closureRow(
  tx: TenantTxClient,
  input: { tenantId: string; facilityId: string; createdById: string },
): Promise<string> {
  const id = newId();
  const startsAt = new Date(Date.now() + 30 * 86_400_000);
  await tx.facilityClosure.create({
    data: {
      id,
      ...input,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      reasonCode: 'maintenance',
    },
  });
  return id;
}

/** A suspension of the unit, started by the booking (a no-show). */
export async function suspensionRow(
  tx: TenantTxClient,
  input: { tenantId: string; unitId: string; triggerBookingId: string },
): Promise<string> {
  const id = newId();
  await tx.bookingSuspension.create({
    data: {
      id,
      ...input,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 86_400_000),
      noShowCount: 3,
    },
  });
  return id;
}

/** A monthly club plan. */
export async function clubPlanRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.clubPlan.create({
    data: {
      id,
      tenantId,
      nameEn: 'Monthly',
      nameAr: 'شهري',
      durationKind: 'monthly',
      price: 500,
    },
  });
  return id;
}

/** The unit's club membership. */
export async function membershipRow(
  tx: TenantTxClient,
  input: { tenantId: string; unitId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.clubMembership.create({ data: { id, ...input } });
  return id;
}

/** Someone a membership covers: an occupancy. */
export async function coveredRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    membershipId: string;
    occupancyId: string;
    addedById: string;
  },
): Promise<string> {
  const id = newId();
  await tx.clubMembershipPerson.create({ data: { id, ...input } });
  return id;
}

/** A payment for the membership, today. */
export async function paymentRow(
  tx: TenantTxClient,
  input: {
    tenantId: string;
    membershipId: string;
    planId: string;
    recordedById: string;
  },
): Promise<string> {
  const id = newId();
  const today = dbDate(day(0));
  await tx.clubPaymentRecord.create({
    data: {
      id,
      ...input,
      kind: 'payment',
      amount: 500,
      currency: 'EGP',
      receiptNumber: `R-${id.slice(-12)}`,
      paidOn: today,
      periodStartsOn: today,
      periodEndsOn: dbDate(day(30)),
    },
  });
  return id;
}

/** A reminder before the membership ends. */
export async function reminderRow(
  tx: TenantTxClient,
  input: { tenantId: string; membershipId: string },
): Promise<string> {
  const id = newId();
  await tx.clubExpiryReminder.create({
    data: { id, ...input, endsOn: new Date('2031-01-01') },
  });
  return id;
}
