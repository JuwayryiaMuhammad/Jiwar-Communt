import type { FacilityBan } from '@prisma/client';
import type { LocalDate } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

export type BanState = 'in_force' | 'ended' | 'lifted';

/** A DATE column's value, and back (as the club's days). */
export const asDate = (d: LocalDate) => new Date(`${d}T00:00:00.000Z`);
export const dayOf = (d: Date): LocalDate => d.toISOString().slice(0, 10);

/** In force on `today`: not lifted, and not past its last day (inclusive). */
export const banState = (b: FacilityBan, today: LocalDate): BanState =>
  b.liftedAt !== null
    ? b.liftReasonCode === 'ended'
      ? 'ended'
      : 'lifted'
    : b.endsOn !== null && dayOf(b.endsOn) < today
      ? 'ended'
      : 'in_force';

/**
 * What a booking reads of facility bans (ADR 0067), in its transaction,
 * which holds the booker's account FOR SHARE: the booker's ban in force at
 * `facilityId` or at every facility on `today`, the one that holds longest
 * (until lifted beats a day).
 */
export async function banInForce(
  tx: TenantTxClient,
  accountId: string,
  facilityId: string,
  today: LocalDate,
): Promise<FacilityBan | null> {
  const bans = await tx.facilityBan.findMany({
    where: {
      accountId,
      liftedAt: null,
      OR: [{ facilityId }, { facilityId: null }],
    },
  });
  const holding = bans.filter((b) => banState(b, today) === 'in_force');
  if (!holding.length) return null;
  return holding.reduce((a, b) =>
    a.endsOn === null ? a : b.endsOn === null || b.endsOn > a.endsOn ? b : a,
  );
}
