import { Injectable } from '@nestjs/common';
import type { Facility } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { HOLDING } from '../bookings/booking-rules';

/**
 * How busy a bookable facility is (ADR 0071, amending ADR 0044): a level,
 * never a count. A share of the capacity below a third is `quiet`, from two
 * thirds `busy`, `normal` between. A people-counted facility counts a
 * booking's seats as its slot does: its party and its companions (ADR
 * 0070, BookingsService.seats).
 */
export type BusyLevel = 'quiet' | 'normal' | 'busy';
export const BUSY_LEVELS: readonly BusyLevel[] = ['quiet', 'normal', 'busy'];

export const levelOf = (share: number): BusyLevel =>
  share >= 2 / 3 ? 'busy' : share >= 1 / 3 ? 'normal' : 'quiet';

/** Weeks the usual level looks back over, and the fewest it needs. */
export const USUAL_WEEKS = 8;
export const USUAL_MIN_WEEKS = 4;
const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The facility's levels: now (what is held at this instant), and usually
 * at this weekday and hour (the mean share over the last eight weeks; null
 * with fewer than four weeks behind it). Walk-in facilities have none.
 */
@Injectable()
export class FacilityBusy {
  async levels(
    tx: TenantTxClient,
    facility: Pick<
      Facility,
      'id' | 'mode' | 'capacity' | 'capacityUnit' | 'slotMinutes' | 'createdAt'
    >,
    now: Date,
    timeZone: string,
  ): Promise<{ busyNow: BusyLevel | null; usuallyBusy: BusyLevel | null }> {
    if (facility.mode !== 'bookable' || !facility.capacity)
      return { busyNow: null, usuallyBusy: null };
    const people = facility.capacityUnit === 'people';
    const held = await tx.booking.findMany({
      where: {
        facilityId: facility.id,
        status: { in: [...HOLDING] },
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      select: { partySize: true, companions: true },
    });
    const takenNow = people
      ? held.reduce((n, b) => n + b.partySize + b.companions, 0)
      : held.length;
    const busyNow = levelOf(takenNow / facility.capacity);
    const weeks = Math.min(
      USUAL_WEEKS,
      Math.floor((now.getTime() - facility.createdAt.getTime()) / WEEK_MS),
    );
    if (weeks < USUAL_MIN_WEEKS) return { busyNow, usuallyBusy: null };
    const since = new Date(now.getTime() - weeks * WEEK_MS);
    const [{ taken }] = await tx.$queryRaw<{ taken: number }[]>`
      SELECT COALESCE(SUM(CASE WHEN ${people} THEN party_size + companions ELSE 1 END), 0)::float AS taken
        FROM bookings
       WHERE facility_id = ${facility.id}::uuid
         AND status::text = ANY(${[...HOLDING]})
         AND starts_at >= ${since} AND starts_at < ${now}
         AND extract(dow FROM starts_at AT TIME ZONE ${timeZone})
             = extract(dow FROM ${now}::timestamptz AT TIME ZONE ${timeZone})
         AND extract(hour FROM starts_at AT TIME ZONE ${timeZone})
             = extract(hour FROM ${now}::timestamptz AT TIME ZONE ${timeZone})`;
    const slotsPerHour = Math.max(
      1,
      Math.floor(HOUR_MS / ((facility.slotMinutes ?? 60) * 60_000)),
    );
    const usuallyBusy = levelOf(
      taken / (weeks * slotsPerHour * facility.capacity),
    );
    return { busyNow, usuallyBusy };
  }
}
