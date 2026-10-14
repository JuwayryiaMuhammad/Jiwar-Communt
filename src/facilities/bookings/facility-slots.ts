// ============================================================================
// A facility's slots (ADR 0044)
// ============================================================================
//
// The facility's weekly hours in the compound's time zone, cut into its
// slot length; a slot that overlaps a peak time is a peak slot. A slot may
// be booked from `minMinutesBefore` before it and up to `maxDaysAhead`
// local days ahead. Pure: the service feeds them what it read.

import {
  addDays,
  localDate,
  localParts,
  overlaps,
  weekdayOf,
  type LocalDate,
  type Slot,
} from '../../core/common/slots/day-slots';
import {
  weeklySlotsOfDay,
  type WeeklyWindow,
} from '../../core/common/slots/weekly-windows';

const MINUTE = 60_000;

export interface FacilityCalendar {
  hours: readonly WeeklyWindow[];
  peaks: readonly WeeklyWindow[];
  slotMinutes: number;
  timeZone: string;
}

export interface FacilitySlot extends Slot {
  peak: boolean;
}

/** Whether the slot overlaps one of the peak times of its local weekday. */
export function isPeak(slot: Slot, cal: FacilityCalendar): boolean {
  const { date, minute } = localParts(slot.startsAt, cal.timeZone);
  const weekday = weekdayOf(date);
  const end =
    minute + (slot.endsAt.getTime() - slot.startsAt.getTime()) / MINUTE;
  return cal.peaks.some(
    (p) => p.weekday === weekday && p.startMinute < end && minute < p.endMinute,
  );
}

/** The slots of one local day, each marked peak or not. */
export function slotsOfDate(
  date: LocalDate,
  cal: FacilityCalendar,
): FacilitySlot[] {
  return weeklySlotsOfDay(date, cal.hours, cal.slotMinutes, cal.timeZone).map(
    (s) => ({ ...s, peak: isPeak(s, cal) }),
  );
}

/**
 * The slot that starts at `startsAt`, if the hours have one: what a booking
 * must name exactly. Null for a time outside the hours or between two
 * slots.
 */
export function slotAt(
  startsAt: Date,
  cal: FacilityCalendar,
): FacilitySlot | null {
  return (
    slotsOfDate(localDate(startsAt, cal.timeZone), cal).find(
      (s) => s.startsAt.getTime() === startsAt.getTime(),
    ) ?? null
  );
}

export type TooEarlyOrLate = 'too_soon' | 'too_far' | null;

/**
 * Whether `now` may book the slot: at least `minMinutesBefore` before its
 * start, and on a local day at most `maxDaysAhead` after today.
 */
export function bookableWhen(
  slot: Slot,
  now: Date,
  rules: { minMinutesBefore: number; maxDaysAhead: number },
  timeZone: string,
): TooEarlyOrLate {
  if (slot.startsAt.getTime() < now.getTime() + rules.minMinutesBefore * MINUTE)
    return 'too_soon';
  const last = addDays(localDate(now, timeZone), rules.maxDaysAhead);
  if (localDate(slot.startsAt, timeZone) > last) return 'too_far';
  return null;
}

/** What of `held` shares an instant with the slot. */
export const heldIn = <T extends Slot>(slot: Slot, held: readonly T[]) =>
  held.filter((b) => overlaps(b, slot));
