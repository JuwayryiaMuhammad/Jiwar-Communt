import { FieldErrorCode, type FieldError } from '../errors';

// ============================================================================
// Weekly schedules
// ============================================================================
//
// Days of the week (0 = Sunday … 6 = Saturday) and time windows in the
// compound's time zone, on a weekly minute timeline. A window whose end is
// before its start runs past midnight into the NEXT day (22:00 → 06:00 on
// Thursday ends Friday 06:00; on Saturday it ends Sunday). A domestic
// worker's visits (ADR 0017) and a guard's weekly roster (ADR 0050) use
// them. An empty schedule means always.

export interface WeeklySchedule {
  days: number[];
  windows: { from: string; to: string }[];
}

export const EMPTY_SCHEDULE: WeeklySchedule = { days: [], windows: [] };

const DAY = 24 * 60;
const WEEK = 7 * DAY; // minutes 0 … 10079, Sunday 00:00 first
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Normalizes a non-empty schedule (days sorted and unique, windows sorted
 * by start), collecting field errors under `field`.
 */
export function checkWeeklySchedule(
  raw: WeeklySchedule | undefined,
  fields: FieldError[],
  field = 'schedule',
): WeeklySchedule {
  const days = [...new Set(raw?.days ?? [])].sort((a, b) => a - b);
  const windows = [...(raw?.windows ?? [])].sort((a, b) =>
    (a?.from ?? '').localeCompare(b?.from ?? ''),
  );
  if (
    !days.length ||
    days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  ) {
    fields.push({
      field: `${field}.days`,
      code: FieldErrorCode.INVALID_VALUE,
      params: { min: 0, max: 6 },
    });
  }
  if (
    !windows.length ||
    windows.some((w) => !TIME.test(w?.from ?? '') || !TIME.test(w?.to ?? ''))
  ) {
    fields.push({
      field: `${field}.windows`,
      code: FieldErrorCode.INVALID_FORMAT,
    });
  } else if (windows.some((w) => w.from === w.to)) {
    // Zero length, or all day? Neither is a window: say which you mean.
    fields.push({
      field: `${field}.windows`,
      code: FieldErrorCode.INVALID_SCHEDULE,
    });
  }
  return { days, windows: windows.map(({ from, to }) => ({ from, to })) };
}

/** Minutes after local midnight of an `HH:MM` the schedule accepted. */
export function minutesOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** How long a window lasts, in minutes; an overnight one wraps. */
export function windowLength(w: { from: string; to: string }): number {
  return (minutesOf(w.to) - minutesOf(w.from) + DAY) % DAY;
}

/** [start, end) intervals on the weekly timeline; overnight windows wrap. */
export function weeklyIntervals(s: WeeklySchedule): [number, number][] {
  const out: [number, number][] = [];
  for (const day of s.days) {
    for (const w of s.windows) {
      const start = day * DAY + minutesOf(w.from);
      const length = windowLength(w);
      const end = start + length;
      if (end <= WEEK) out.push([start, end]);
      else out.push([start, WEEK], [0, end - WEEK]); // Saturday night → Sunday
    }
  }
  return out;
}

const isAlways = (s: WeeklySchedule) => !s.days.length && !s.windows.length;

/**
 * Two schedules overlap when their weekly intervals intersect. Touching
 * edges (one ends at 06:00, the other starts at 06:00) do not overlap. A
 * live-in (empty) schedule overlaps everything.
 */
export function schedulesOverlap(
  a: WeeklySchedule,
  b: WeeklySchedule,
): boolean {
  if (isAlways(a) || isAlways(b)) return true;
  const ib = weeklyIntervals(b);
  return weeklyIntervals(a).some(([s1, e1]) =>
    ib.some(([s2, e2]) => s1 < e2 && s2 < e1),
  );
}

/**
 * Whether `instant` falls inside the schedule, read in the compound's time
 * zone (tenant_settings.timezone). For the gate: an overnight window that
 * started yesterday still covers this morning.
 */
export function isWithinSchedule(
  schedule: WeeklySchedule,
  instant: Date,
  timeZone: string,
): boolean {
  if (isAlways(schedule)) return true;
  const t = minuteOfWeek(instant, timeZone);
  return weeklyIntervals(schedule).some(([s, e]) => s <= t && t < e);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function minuteOfWeek(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return (
    WEEKDAYS.indexOf(get('weekday')) * DAY +
    Number(get('hour')) * 60 +
    Number(get('minute'))
  );
}
