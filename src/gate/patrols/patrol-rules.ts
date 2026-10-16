// ============================================================================
// Patrols (ADR 0052): the pure rules.
// ============================================================================
//
// What a route's schedule makes, when a run is late, missed or timed out,
// and when a scan is believed. The services decide by these, under their
// locks and by the database's clock.

import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import type { LocalDate } from '../../core/common/slots/day-slots';
import {
  minutesOf,
  weeklyIntervals,
  type WeeklySchedule,
} from '../../core/common/slots/weekly-schedule';
import { occurrences, type Interval } from '../roster/roster-rules';

/** A checkpoint's and a route's names, in either language. */
export const CHECKPOINT_NAME = { min: 1, max: 60 } as const;
export const LATITUDE = { min: -90, max: 90 } as const;
export const LONGITUDE = { min: -180, max: 180 } as const;
/** How near a scan should be to a checkpoint, in metres. */
export const RADIUS_M = { min: 5, max: 500 } as const;
export const DEFAULT_RADIUS_M = 30;
/** A route's checkpoints. */
export const ROUTE_CHECKPOINTS = { min: 1, max: 50 } as const;
/** How long a route takes, in minutes. */
export const EXPECTED_MINUTES = { min: 5, max: 480 } as const;
/** Start times on each day a route is scheduled. */
export const TIMES_PER_DAY = { min: 1, max: 24 } as const;
/** A scheduled run's window lasts at least this long. */
export const MIN_WINDOW_MINUTES = 30;
/** How far ahead scheduled runs are made. */
export const HORIZON_DAYS = 7;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A route's weekly start times, in the compound's time zone (ADR 0052). */
export interface PatrolSchedule {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** `HH:MM`, each a run's start. */
  times: string[];
}

/**
 * How long a scheduled run may be started for: its expected length, at
 * least 30 minutes, so being late (15 minutes) always comes before being
 * missed.
 */
export const windowMinutes = (expectedMinutes: number) =>
  Math.max(expectedMinutes, MIN_WINDOW_MINUTES);

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The schedule as the weekly windows each start opens. */
export function scheduleWindows(
  s: PatrolSchedule,
  expectedMinutes: number,
): WeeklySchedule {
  const length = windowMinutes(expectedMinutes);
  return {
    days: s.days,
    windows: s.times.map((t) => ({
      from: t,
      to: hhmm((minutesOf(t) + length) % (24 * 60)),
    })),
  };
}

/**
 * Normalizes a schedule (days and times sorted and unique), collecting
 * field errors under `schedule`. Two starts closer than a run's window, on
 * the same day, over midnight or from Saturday into Sunday, are
 * PATROL_SCHEDULE_OVERLAP: a run's window would still be open when the
 * next one starts.
 */
export function checkPatrolSchedule(
  raw: PatrolSchedule,
  expectedMinutes: number,
  fields: FieldError[],
  field = 'schedule',
): PatrolSchedule {
  const days = [...new Set(raw?.days ?? [])].sort((a, b) => a - b);
  const times = [...new Set(raw?.times ?? [])].sort();
  const daysOk =
    days.length > 0 &&
    days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!daysOk)
    fields.push({
      field: `${field}.days`,
      code: FieldErrorCode.INVALID_VALUE,
      params: { min: 0, max: 6 },
    });
  if (times.some((t) => typeof t !== 'string' || !TIME.test(t)))
    fields.push({
      field: `${field}.times`,
      code: FieldErrorCode.INVALID_FORMAT,
    });
  else if (times.length < TIMES_PER_DAY.min || times.length > TIMES_PER_DAY.max)
    fields.push({
      field: `${field}.times`,
      code: FieldErrorCode.INVALID_LENGTH,
      params: { ...TIMES_PER_DAY },
    });
  else if (daysOk && scheduleOverlaps({ days, times }, expectedMinutes))
    fields.push({
      field: `${field}.times`,
      code: FieldErrorCode.PATROL_SCHEDULE_OVERLAP,
      params: { minutes: windowMinutes(expectedMinutes) },
    });
  return { days, times };
}

/** Whether two of the schedule's windows share a minute of the week. */
export function scheduleOverlaps(
  s: PatrolSchedule,
  expectedMinutes: number,
): boolean {
  const intervals = weeklyIntervals(scheduleWindows(s, expectedMinutes));
  return intervals.some(([s1, e1], i) =>
    intervals.some(([s2, e2], j) => i < j && s1 < e2 && s2 < e1),
  );
}

/**
 * The scheduled runs a version makes on the compound's days `from` … `to`
 * (inclusive): each start, and the end of the window it may be started in
 * (DST handled as the roster's slots are).
 */
export function runOccurrences(
  s: PatrolSchedule,
  expectedMinutes: number,
  from: LocalDate,
  to: LocalDate,
  timeZone: string,
): Interval[] {
  return occurrences(
    scheduleWindows(s, expectedMinutes),
    { from, until: null },
    from,
    to,
    timeZone,
  );
}

/** The schedule a version row holds, or null. */
export function scheduleOf(json: unknown): PatrolSchedule | null {
  if (!json || typeof json !== 'object') return null;
  const s = json as Partial<PatrolSchedule>;
  return Array.isArray(s.days) && Array.isArray(s.times)
    ? { days: s.days, times: s.times }
    : null;
}
