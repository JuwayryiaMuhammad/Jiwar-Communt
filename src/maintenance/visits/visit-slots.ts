// ============================================================================
// Visit slots (ADR 0038)
// ============================================================================
//
// The windows a resident may pick when a visit moves: the compound's
// visiting hours, cut into slots, read in the compound's time zone, minus
// what the rules refuse (too soon, too far) and the technician's other
// active visits. Pure functions: the service feeds them what it read.

import { MAX_AHEAD_MS, MIN_LEAD_MS } from './visit-rules';

const MINUTE = 60_000;

/** A week of slots unless the app asks for another number of days. */
export const DEFAULT_SLOT_DAYS = 7;
export const SLOT_DAYS = { min: 1, max: 14 } as const;

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

export interface VisitingHours {
  /** Minutes after local midnight. */
  startMinute: number;
  /** Minutes after local midnight; after the start. */
  endMinute: number;
  slotMinutes: number;
}

/** One local calendar day, `YYYY-MM-DD`. */
export type LocalDate = string;

/** The local `YYYY-MM-DD` and minute of the day of an instant. */
function localParts(
  instant: Date,
  timeZone: string,
): { date: LocalDate; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/**
 * The instant at which the local clock of `timeZone` reads `minute` on
 * `date`, or null when that local time does not exist (a daylight-saving
 * gap). An ambiguous time (the hour repeated in autumn) is its first
 * occurrence.
 */
export function zonedInstant(
  date: LocalDate,
  minute: number,
  timeZone: string,
): Date | null {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + minute * MINUTE;
  // The offset is at most ±14 h; try the offsets in force around the wall
  // time, earliest instant first, and keep the one that reads back.
  const candidates = new Set<number>();
  for (const probe of [wall - 14 * 60 * MINUTE, wall, wall + 14 * 60 * MINUTE])
    candidates.add(wall - offsetAt(new Date(probe), timeZone));
  for (const t of [...candidates].sort((a, b) => a - b)) {
    const back = localParts(new Date(t), timeZone);
    if (back.date === date && back.minute === minute) return new Date(t);
  }
  return null;
}

/** How far the local clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const [y, m, d] = p.date.split('-').map(Number);
  const local = Date.UTC(y, m - 1, d) + p.minute * MINUTE;
  return local - Math.floor(instant.getTime() / MINUTE) * MINUTE;
}

/** `date` plus `n` days, as a calendar date. */
export function addDays(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Today in the compound's time zone. */
export function localDate(instant: Date, timeZone: string): LocalDate {
  return localParts(instant, timeZone).date;
}

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
    const date = addDays(input.from, day);
    for (
      let minute = hours.startMinute;
      minute + hours.slotMinutes <= hours.endMinute;
      minute += hours.slotMinutes
    ) {
      // A start in a daylight-saving gap does not exist: no slot.
      const startsAt = zonedInstant(date, minute, input.timeZone);
      if (!startsAt) continue;
      const start = startsAt.getTime();
      // A slot lasts its length in real time, across a clock change too.
      const endsAt = new Date(start + hours.slotMinutes * MINUTE);
      if (start < earliest || start > latest) continue;
      if (
        input.busy.some(
          (b) =>
            b.startsAt.getTime() < endsAt.getTime() &&
            start < b.endsAt.getTime(),
        )
      )
        continue;
      out.push({ startsAt, endsAt });
    }
  }
  return out;
}
