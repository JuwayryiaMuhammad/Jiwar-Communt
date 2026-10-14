import type { FacilityClosure } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * What bookings and the facility views read of closures (ADR 0044), in the
 * caller's transaction. A closure in force is one not lifted.
 */

/** Whether a closure in force overlaps the window. */
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
  return found !== null;
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
