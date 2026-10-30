import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import type { FacilityRules } from '../setup/facility-rules';

/** A report's days: 30 ending today by default, at most a year and a day. */
export const USAGE_DEFAULT_DAYS = 30;
export const USAGE_MAX_DAYS = 366;

export interface UsagePeriod {
  from: LocalDate;
  to: LocalDate;
  days: number;
}

const MINUTE = 60_000;

/** The calendar days from `from` to `to`, both included (one past the most, at most). */
export function daysOf(p: { from: LocalDate; to: LocalDate }): LocalDate[] {
  const out: LocalDate[] = [];
  for (
    let d = p.from;
    d <= p.to && out.length <= USAGE_MAX_DAYS;
    d = addDays(d, 1)
  )
    out.push(d);
  return out;
}

/** The period asked for, as the economics reports resolve theirs (ADR 0065). */
export function usagePeriod(
  q: { from?: LocalDate; to?: LocalDate },
  today: LocalDate,
): UsagePeriod | FieldError[] {
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, 1 - USAGE_DEFAULT_DAYS);
  if (to < from)
    return [{ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START }];
  const days = daysOf({ from, to }).length;
  if (days > USAGE_MAX_DAYS)
    return [
      {
        field: 'from',
        code: FieldErrorCode.PERIOD_TOO_LONG,
        params: { max: USAGE_MAX_DAYS },
      },
    ];
  return { from, to, days };
}

export interface Window {
  startsAt: Date;
  endsAt: Date;
}

export interface UsedBooking extends Window {
  status: string;
  partySize: number;
  peak: boolean;
}

export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'rejected',
  'cancelled',
  'no_show',
] as const;

export interface Usage {
  bookings: Record<(typeof BOOKING_STATUSES)[number], number>;
  /** The open time of its slots, minus the closures in force. */
  openMinutes: number;
  /** Booked slot-time, in its capacity's terms: a place held for a minute is one. */
  bookedMinutes: number;
  /** bookedMinutes over openMinutes × capacity, whole percent; null when it was never open. */
  use: number | null;
  noShows: number;
  /** No-shows over what was confirmed or a no-show, whole percent. */
  noShowRate: number | null;
  /** Of what held a place (pending, confirmed, no-show), the share at peak times. */
  peakShare: number | null;
}

const minutes = (w: Window) =>
  (w.endsAt.getTime() - w.startsAt.getTime()) / MINUTE;
const overlaps = (a: Window, b: Window) =>
  a.startsAt.getTime() < b.endsAt.getTime() &&
  b.startsAt.getTime() < a.endsAt.getTime();
const percent = (part: number, whole: number) =>
  whole === 0 ? null : Math.floor((part * 100) / whole);

/**
 * A facility's use over a period (ADR 0067), computed on read from its
 * bookings, the slots its hours offered and the closures in force: a slot a
 * closure overlaps was not open.
 */
export function usageOf(
  rules: FacilityRules,
  slots: readonly Window[],
  closures: readonly Window[],
  bookings: readonly UsedBooking[],
): Usage {
  const counts = Object.fromEntries(
    BOOKING_STATUSES.map((s) => [s, 0]),
  ) as Usage['bookings'];
  for (const b of bookings)
    if (b.status in counts) counts[b.status as keyof Usage['bookings']]++;
  const openMinutes = slots
    .filter((s) => !closures.some((c) => overlaps(s, c)))
    .reduce((sum, s) => sum + minutes(s), 0);
  const held = bookings.filter((b) =>
    ['pending', 'confirmed', 'no_show'].includes(b.status),
  );
  const bookedMinutes = held.reduce(
    (sum, b) =>
      sum + minutes(b) * (rules.capacityUnit === 'people' ? b.partySize : 1),
    0,
  );
  return {
    bookings: counts,
    openMinutes,
    bookedMinutes,
    use: percent(bookedMinutes, openMinutes * rules.capacity),
    noShows: counts.no_show,
    noShowRate: percent(counts.no_show, counts.confirmed + counts.no_show),
    peakShare: percent(held.filter((b) => b.peak).length, held.length),
  };
}
