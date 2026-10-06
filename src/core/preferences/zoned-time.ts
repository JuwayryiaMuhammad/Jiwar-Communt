/**
 * Wall-clock time in an IANA time zone (a compound's
 * `tenant_settings.timezone`) with Intl only. Offsets are looked up at the
 * instant itself, so days that change to or from summer time come out
 * right.
 */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const HOUR = 3_600_000;

const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(timeZone, f);
  }
  return f;
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of format(timeZone).formatToParts(instant))
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

/** Minutes since local midnight (0 … 1439). */
export function localMinutes(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/** How far the zone's wall clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(new Date(instant), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant at which the zone's clock shows this local date and time. A
 * time skipped by a change to summer time comes out an hour later; a time
 * that happens twice comes out as its first occurrence. (At most one change
 * of offset within a day either side, as in every real zone.)
 */
export function zonedInstant(
  date: { year: number; month: number; day: number },
  minutes: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    Math.floor(minutes / 60),
    minutes % 60,
  );
  const before = wall - offsetAt(wall - 12 * HOUR, timeZone);
  const after = wall - offsetAt(wall + 12 * HOUR, timeZone);
  const shows = (t: number) => {
    const p = localParts(new Date(t), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wall;
  };
  const valid = [before, after].filter(shows);
  // Both: the time happens twice. Neither: it was skipped, and the offset
  // from before the change puts it after the gap.
  return new Date(valid.length ? Math.min(...valid) : before);
}

/** The local calendar date `days` after the given one. */
export function addLocalDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` → minutes since midnight; null when malformed. */
export function parseTime(value: string): number | null {
  const m = TIME.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
