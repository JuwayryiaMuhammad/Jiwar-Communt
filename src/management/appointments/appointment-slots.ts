// ============================================================================
// Appointment slots (ADR 0039)
// ============================================================================
//
// The times a resident may meet the management: the compound's office hours
// (weekly windows, in its time zone) cut into slots of the compound's
// length, minus what is too soon or too far and what is full. A slot takes
// `capacity` appointments. Pure functions over the shared calendar of a
// local day: the service feeds them what it read.

import {
  addDays,
  localDate,
  overlaps,
  slotsOfDay,
  weekdayOf,
  type LocalDate,
  type Slot,
} from '../../core/common/slots/day-slots';
import type { OfficeWindow } from '../settings/defaults';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** An appointment starts at least an hour from now… */
export const MIN_LEAD_MS = 60 * MINUTE;
/** …and at most thirty days from now. */
export const MAX_AHEAD_MS = 30 * DAY;

/** A week of slots unless the app asks for another number of days. */
export const DEFAULT_SLOT_DAYS = 7;
export const SLOT_DAYS = { min: 1, max: 31 } as const;

export interface OfficeCalendar {
  windows: readonly OfficeWindow[];
  slotMinutes: number;
  timeZone: string;
}

/** A slot and how many more appointments it takes. */
export interface OpenSlot extends Slot {
  remaining: number;
}

/** The slots of one local day: its weekday's windows, each cut. */
export function officeSlotsOfDay(date: LocalDate, cal: OfficeCalendar): Slot[] {
  const weekday = weekdayOf(date);
  return cal.windows
    .filter((w) => w.weekday === weekday)
    .sort((a, b) => a.startMinute - b.startMinute)
    .flatMap((w) =>
      slotsOfDay(
        date,
        {
          startMinute: w.startMinute,
          endMinute: w.endMinute,
          slotMinutes: cal.slotMinutes,
        },
        cal.timeZone,
      ),
    );
}

/** Not too soon and not too far, by `now`. */
export const bookable = (slot: Slot, now: Date) =>
  slot.startsAt.getTime() >= now.getTime() + MIN_LEAD_MS &&
  slot.startsAt.getTime() <= now.getTime() + MAX_AHEAD_MS;

/** How many of `booked` share an instant with the window. */
export const takenIn = (window: Slot, booked: readonly Slot[]) =>
  booked.filter((b) => overlaps(b, window)).length;

/**
 * The slots still open on `days` local days from `from`: bookable by
 * `now`, with fewer than `capacity` live appointments on them. Counted by
 * overlap, so an appointment booked before the slot length changed still
 * takes its place.
 */
export function openSlots(input: {
  from: LocalDate;
  days: number;
  calendar: OfficeCalendar;
  capacity: number;
  now: Date;
  booked: readonly Slot[];
}): OpenSlot[] {
  const out: OpenSlot[] = [];
  for (let day = 0; day < input.days; day++)
    for (const slot of officeSlotsOfDay(
      addDays(input.from, day),
      input.calendar,
    )) {
      if (!bookable(slot, input.now)) continue;
      const remaining = input.capacity - takenIn(slot, input.booked);
      if (remaining > 0) out.push({ ...slot, remaining });
    }
  return out;
}

/**
 * The slot that starts at `startsAt`, if the office hours have one: what a
 * booking must name exactly. Null for a time outside the hours or between
 * two slots.
 */
export function slotAt(startsAt: Date, cal: OfficeCalendar): Slot | null {
  return (
    officeSlotsOfDay(localDate(startsAt, cal.timeZone), cal).find(
      (s) => s.startsAt.getTime() === startsAt.getTime(),
    ) ?? null
  );
}
