import type { CommunityEvent } from '@prisma/client';

// ============================================================================
// An event's life (ADR 0040), from its dates and the database's clock.
// ============================================================================

export type EventStatus = 'upcoming' | 'ongoing' | 'ended' | 'cancelled';
export const EVENT_STATUSES = [
  'upcoming',
  'ongoing',
  'ended',
  'cancelled',
] as const satisfies readonly EventStatus[];

type Dates = Pick<CommunityEvent, 'startsAt' | 'endsAt' | 'cancelledAt'>;

export function eventStatus(e: Dates, now: Date): EventStatus {
  if (e.cancelledAt) return 'cancelled';
  if (now < e.startsAt) return 'upcoming';
  return now < e.endsAt ? 'ongoing' : 'ended';
}

/** Each status as a query condition, for the staff's filter. */
export function eventStatusWhere(status: EventStatus, now: Date) {
  switch (status) {
    case 'cancelled':
      return { cancelledAt: { not: null } };
    case 'upcoming':
      return { cancelledAt: null, startsAt: { gt: now } };
    case 'ongoing':
      return { cancelledAt: null, startsAt: { lte: now }, endsAt: { gt: now } };
    case 'ended':
      return { cancelledAt: null, endsAt: { lte: now } };
  }
}

/** Seats one answer takes: the person and their guests, when going. */
export const seatsOf = (rsvp: { response: string; guests: number }) =>
  rsvp.response === 'going' ? 1 + rsvp.guests : 0;

/**
 * Whether `wanted` more seats fit, given the seats others hold. No
 * capacity: always. Guests count: an event for 10 takes 10 people in all.
 */
export function fits(
  capacity: number | null,
  takenByOthers: number,
  wanted: number,
): boolean {
  return capacity === null || takenByOthers + wanted <= capacity;
}
