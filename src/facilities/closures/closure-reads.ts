import type { FacilityClosure } from '@prisma/client';
import type { Slot } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * What bookings and the facility views read of closures (ADR 0044), in the
 * caller's transaction. A closure in force is one not lifted.
 */

/**
 * Whether a closure in force, or an approved use of the facility's common
 * area (ADR 0084), overlaps the window: either way the facility is closed
 * to bookings then. A booking reads it under the facility's row FOR SHARE;
 * a closure and a use's approval take that row FOR UPDATE.
 */
export async function closedOver(
  tx: TenantTxClient,
  facilityId: string,
  window: { startsAt: Date; endsAt: Date },
): Promise<boolean> {
  const found = await tx.facilityClosure.findFirst({
    where: {
      facilityId,
      liftedAt: null,
      startsAt: { lt: window.endsAt },
      endsAt: { gt: window.startsAt },
    },
    select: { id: true },
  });
  if (found) return true;
  return (
    (await reservationsBetween(tx, facilityId, window.startsAt, window.endsAt))
      .length > 0
  );
}

/**
 * The approved uses of the facility's common area (ADR 0084) over a
 * stretch of time, in order of start: the times it is reserved.
 */
export async function reservationsBetween(
  tx: TenantTxClient,
  facilityId: string,
  from: Date,
  to: Date,
): Promise<Slot[]> {
  const rows = await tx.$queryRaw<{ starts_at: Date; ends_at: Date }[]>`
    SELECT r.starts_at, r.ends_at
      FROM space_use_requests r
      JOIN common_areas a ON a.id = r.common_area_id
     WHERE a.facility_id = ${facilityId}::uuid
       AND r.status = 'approved'
       AND r.starts_at < ${to} AND r.ends_at > ${from}
     ORDER BY r.starts_at, r.id`;
  return rows.map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at }));
}

/** The closures in force over a stretch of time, in order of start. */
export function closuresBetween(
  tx: TenantTxClient,
  facilityId: string,
  from: Date,
  to: Date,
): Promise<FacilityClosure[]> {
  return tx.facilityClosure.findMany({
    where: {
      facilityId,
      liftedAt: null,
      startsAt: { lt: to },
      endsAt: { gt: from },
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
}

/** The closures not lifted and not over, soonest first: what residents are shown. */
export function upcomingClosures(
  tx: TenantTxClient,
  facilityIds: readonly string[],
  now: Date,
): Promise<FacilityClosure[]> {
  if (!facilityIds.length) return Promise.resolve([]);
  return tx.facilityClosure.findMany({
    where: {
      facilityId: { in: [...facilityIds] },
      liftedAt: null,
      endsAt: { gt: now },
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
}
