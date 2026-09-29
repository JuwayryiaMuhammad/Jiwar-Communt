import type { WorkerCapacity } from '@prisma/client';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';

/**
 * When a worker comes (ADR 0017): days of the week (0 = Sunday … 6 =
 * Saturday) and time windows in the compound's local time. A live-in worker
 * has an empty schedule: always there.
 */
export interface WorkerSchedule {
  days: number[];
  windows: { from: string; to: string }[];
}

export const EMPTY_SCHEDULE: WorkerSchedule = { days: [], windows: [] };

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
    a.from.localeCompare(b.from),
  );
  const badDays =
    !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6);
  const badWindows =
    !windows.length ||
    windows.some(
      (w) =>
        !TIME.test(w?.from ?? '') || !TIME.test(w?.to ?? '') || w.from >= w.to,
    );
  if (badDays) {
    fields.push({
      field: 'schedule.days',
      code: FieldErrorCode.INVALID_VALUE,
      params: { min: 0, max: 6 },
    });
  }
  if (badWindows) {
    fields.push({
      field: 'schedule.windows',
      code: FieldErrorCode.INVALID_FORMAT,
    });
  }
  return { days, windows: windows.map(({ from, to }) => ({ from, to })) };
}

const isAlways = (s: WorkerSchedule) => !s.days.length && !s.windows.length;

/**
 * Two schedules overlap when they share a day and a time window. A live-in
 * (empty) schedule overlaps everything.
 */
export function schedulesOverlap(
  a: WorkerSchedule,
  b: WorkerSchedule,
): boolean {
  if (isAlways(a) || isAlways(b)) return true;
  if (!a.days.some((d) => b.days.includes(d))) return false;
  return a.windows.some((x) =>
    b.windows.some((y) => x.from < y.to && y.from < x.to),
  );
}
