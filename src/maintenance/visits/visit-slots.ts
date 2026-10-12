// ============================================================================
// Visit slots (ADR 0038)
// ============================================================================
//
// The windows a resident may pick when a visit moves: the compound's
// visiting hours, cut into slots, read in the compound's time zone, minus
// what the rules refuse (too soon, too far) and the technician's other
// active visits. Pure functions: the service feeds them what it read.

import {
  addDays,
  localDate,
  localParts,
  overlaps,
  slotsOfDay,
  zonedInstant,
  type DayWindow,
  type LocalDate,
  type Slot,
} from '../../core/common/slots/day-slots';
import { MAX_AHEAD_MS, MIN_LEAD_MS } from './visit-rules';

// The calendar of a local day is shared with the management appointments
// (ADR 0039): it lives in core, and is still read from here.
export { addDays, localDate, zonedInstant, type LocalDate, type Slot };

/** A week of slots unless the app asks for another number of days. */
export const DEFAULT_SLOT_DAYS = 7;
export const SLOT_DAYS = { min: 1, max: 14 } as const;

/** The compound's visiting hours: one window, every day. */
export type VisitingHours = DayWindow;

/**
 * Whether a window lies inside the visiting hours, on one local day of
 * `timeZone` (ADR 0038): what a preventive request must ask for, because
 * nobody looks at its window before it is proposed.
 */
export function withinVisitingHours(
  window: Slot,
  hours: Pick<VisitingHours, 'startMinute' | 'endMinute'>,
  timeZone: string,
): boolean {
  const start = localParts(window.startsAt, timeZone);
  // The last instant of the window: an end at midnight is still that day.
  const end = localParts(new Date(window.endsAt.getTime() - 1), timeZone);
  return (
    start.date === end.date &&
    start.minute >= hours.startMinute &&
    end.minute < hours.endMinute
  );
}

/**
 * The free slots of `days` local days from `from`: each day's visiting
 * hours cut into `slotMinutes`, kept only when a proposal there would be
 * accepted (at least 15 minutes and at most 30 days ahead of `now`, ADR
 * 0034) and when it overlaps none of `busy`.
 */
export function freeSlots(input: {
  from: LocalDate;
  days: number;
  hours: VisitingHours;
  timeZone: string;
  now: Date;
  busy: readonly Slot[];
}): Slot[] {
  const { hours, now } = input;
  const earliest = now.getTime() + MIN_LEAD_MS;
  const latest = now.getTime() + MAX_AHEAD_MS;
  const out: Slot[] = [];
  for (let day = 0; day < input.days; day++) {
    for (const slot of slotsOfDay(
      addDays(input.from, day),
      hours,
      input.timeZone,
    )) {
      const start = slot.startsAt.getTime();
      if (start < earliest || start > latest) continue;
      if (input.busy.some((b) => overlaps(b, slot))) continue;
      out.push(slot);
    }
  }
  return out;
}
