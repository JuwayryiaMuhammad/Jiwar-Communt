// ============================================================================
// Slots of a local day
// ============================================================================
//
// What every "pick a time" of a compound is cut from: a window of minutes
// after local midnight, in the compound's time zone, cut into slots of a
// length. Pure functions, shared by the maintenance visits (ADR 0038) and
// the management appointments (ADR 0039); each adds its own rules on top
// (how soon, how far ahead, what is already taken).

const MINUTE = 60_000;

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

/** A window of one local day, cut into slots of `slotMinutes`. */
export interface DayWindow {
  /** Minutes after local midnight. */
  startMinute: number;
  /** Minutes after local midnight; after the start. */
  endMinute: number;
  slotMinutes: number;
}

/** One local calendar day, `YYYY-MM-DD`. */
export type LocalDate = string;

/** The local `YYYY-MM-DD` and minute of the day of an instant. */
export function localParts(
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

/** The weekday of a calendar date: 0 is Sunday, 6 is Saturday. */
export function weekdayOf(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The slots of one local day: the window cut into `slotMinutes`, each
 * starting on the local clock and lasting its length in real time (across
 * a clock change too). A start in a daylight-saving gap does not exist: no
 * slot. A last piece shorter than a slot is not one.
 */
export function slotsOfDay(
  date: LocalDate,
  window: DayWindow,
  timeZone: string,
): Slot[] {
  const out: Slot[] = [];
  for (
    let minute = window.startMinute;
    minute + window.slotMinutes <= window.endMinute;
    minute += window.slotMinutes
  ) {
    const startsAt = zonedInstant(date, minute, timeZone);
    if (!startsAt) continue;
    out.push({
      startsAt,
      endsAt: new Date(startsAt.getTime() + window.slotMinutes * MINUTE),
    });
  }
  return out;
}

/** Whether two windows share an instant (touching ones do not). */
export const overlaps = (a: Slot, b: Slot) =>
  a.startsAt.getTime() < b.endsAt.getTime() &&
  b.startsAt.getTime() < a.endsAt.getTime();
