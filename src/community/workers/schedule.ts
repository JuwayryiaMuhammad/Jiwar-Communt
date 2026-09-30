import type { WorkerCapacity } from '@prisma/client';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';

/**
 * When a worker comes (ADR 0017): days of the week (0 = Sunday … 6 =
 * Saturday) and time windows in the compound's time zone. A window whose
 * end is before its start runs past midnight into the NEXT day (22:00 →
 * 06:00 on Thursday ends Friday 06:00; on Saturday it ends Sunday). A
 * live-in worker has an empty schedule: always there.
 */
export interface WorkerSchedule {
  days: number[];
  windows: { from: string; to: string }[];
}

export const EMPTY_SCHEDULE: WorkerSchedule = { days: [], windows: [] };

const DAY = 24 * 60;
const WEEK = 7 * DAY; // minutes 0 … 10079, Sunday 00:00 first
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Normalizes a schedule for its capacity, collecting field errors. */
export function checkSchedule(
  capacity: WorkerCapacity,
  raw: WorkerSchedule | undefined,
  fields: FieldError[],
): WorkerSchedule {
  if (capacity === 'live_in') {
    if (raw && (raw.days?.length || raw.windows?.length)) {
      fields.push({
        field: 'schedule',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    }
    return EMPTY_SCHEDULE;
  }
  const days = [...new Set(raw?.days ?? [])].sort((a, b) => a - b);
  const windows = [...(raw?.windows ?? [])].sort((a, b) =>
    (a?.from ?? '').localeCompare(b?.from ?? ''),
  );
  if (
    !days.length ||
    days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  ) {
    fields.push({
      field: 'schedule.days',
      code: FieldErrorCode.INVALID_VALUE,
      params: { min: 0, max: 6 },
    });
  }
  if (
    !windows.length ||
    windows.some((w) => !TIME.test(w?.from ?? '') || !TIME.test(w?.to ?? ''))
  ) {
    fields.push({
      field: 'schedule.windows',
      code: FieldErrorCode.INVALID_FORMAT,
    });
  } else if (windows.some((w) => w.from === w.to)) {
    // Zero length, or all day? Neither is a window: say which you mean.
    fields.push({
      field: 'schedule.windows',
      code: FieldErrorCode.INVALID_SCHEDULE,
    });
  }
  return { days, windows: windows.map(({ from, to }) => ({ from, to })) };
}

/** [start, end) intervals on the weekly timeline; overnight windows wrap. */
export function weeklyIntervals(s: WorkerSchedule): [number, number][] {
  const out: [number, number][] = [];
  for (const day of s.days) {
    for (const w of s.windows) {
      const start = day * DAY + minutes(w.from);
      const length = (minutes(w.to) - minutes(w.from) + DAY) % DAY;
      const end = start + length;
      if (end <= WEEK) out.push([start, end]);
      else out.push([start, WEEK], [0, end - WEEK]); // Saturday night → Sunday
    }
  }
  return out;
}

const isAlways = (s: WorkerSchedule) => !s.days.length && !s.windows.length;

/**
 * Two schedules overlap when their weekly intervals intersect. Touching
 * edges (one ends at 06:00, the other starts at 06:00) do not overlap. A
 * live-in (empty) schedule overlaps everything.
 */
export function schedulesOverlap(
  a: WorkerSchedule,
  b: WorkerSchedule,
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
  schedule: WorkerSchedule,
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

function minutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}
