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

// ----------------------------------------------------------------------------
// Runs
// ----------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/** Not started this long after its start, a scheduled run is late. */
export const LATE_AFTER_MINUTES = 15;
/** A scheduled run may be started this long before its start. */
export const EARLY_START_MINUTES = 15;
/** A run under way this many times its expected minutes is timed out. */
export const TIMEOUT_FACTOR = 2;
/** The guard's board shows the scheduled runs opening within this many hours. */
export const BOARD_AHEAD_HOURS = 12;

/** Why a scheduled run cannot be started at `at`, or null. */
export function startProblem(
  run: { scheduledStart: Date; windowEndsAt: Date },
  at: Date,
): 'too_early' | 'window_closed' | null {
  const opens = run.scheduledStart.getTime() - EARLY_START_MINUTES * MINUTE_MS;
  if (at.getTime() < opens) return 'too_early';
  if (at.getTime() >= run.windowEndsAt.getTime()) return 'window_closed';
  return null;
}

/** When a scheduled run is late, if nobody started it. */
export const lateAfter = (scheduledStart: Date) =>
  new Date(scheduledStart.getTime() + LATE_AFTER_MINUTES * MINUTE_MS);

/** When a run under way is timed out. */
export const timeoutAt = (startedAt: Date, expectedMinutes: number) =>
  new Date(startedAt.getTime() + TIMEOUT_FACTOR * expectedMinutes * MINUTE_MS);

/** How a run under way ends: every checkpoint scanned, or not. */
export const endStatus = (scanned: number, total: number) =>
  scanned >= total ? ('completed' as const) : ('incomplete' as const);

// ----------------------------------------------------------------------------
// Scans and notes
// ----------------------------------------------------------------------------

/** How far a device's clock may stray from a run's lifetime, either side. */
export const SCAN_GRACE_MINUTES = 2;
/** A note may come this long after its run ended (photos upload slowly). */
export const NOTE_AFTER_END_MINUTES = 30;
export const NOTE_TEXT = { min: 1, max: 1000 } as const;
export const MAX_NOTE_PHOTOS = 3;
/** A device's reported accuracy, in metres. */
export const ACCURACY_M = { min: 0, max: 10_000 } as const;

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** The great-circle distance between two points, in whole metres. */
export function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Whether a device time falls in a run's lifetime: from its start until
 * its end (or `now` while under way), two minutes either side.
 */
export function inRunLifetime(
  run: { startedAt: Date; endedAt: Date | null },
  at: Date,
  now: Date,
): boolean {
  const grace = SCAN_GRACE_MINUTES * MINUTE_MS;
  const until = (run.endedAt ?? now).getTime() + grace;
  return (
    at.getTime() >= run.startedAt.getTime() - grace && at.getTime() <= until
  );
}

/**
 * The position an ordered route expects next: one after the last scan's,
 * and never a device time before it. Null when this one is in order.
 */
export function orderProblem(
  last: { position: number; scannedAt: Date } | null,
  position: number,
  scannedAt: Date,
): { expected: number } | null {
  const expected = (last?.position ?? 0) + 1;
  if (position !== expected) return { expected };
  if (last && scannedAt < last.scannedAt) return { expected };
  return null;
}

// ----------------------------------------------------------------------------
// Track points
// ----------------------------------------------------------------------------

/** Points in one batch. */
export const TRACK_BATCH = { min: 1, max: 100 } as const;
/** A batch may come this long after its run ended (the offline queue). */
export const TRACK_AFTER_END_MINUTES = NOTE_AFTER_END_MINUTES;
/** A point is deleted this long after it was recorded. */
export const TRACK_RETENTION_DAYS = 30;
/** The most points one read answers. */
export const TRACK_READ_MAX = 5000;
