import type { WorkerCapacity } from '@prisma/client';
import {
  checkWeeklySchedule,
  EMPTY_SCHEDULE,
  type WeeklySchedule,
} from '../../core/common/slots/weekly-schedule';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';

export {
  EMPTY_SCHEDULE,
  isWithinSchedule,
  minuteOfWeek,
  schedulesOverlap,
  weeklyIntervals,
} from '../../core/common/slots/weekly-schedule';

/**
 * When a worker comes (ADR 0017): a weekly schedule in the compound's time
 * zone (src/core/common/slots/weekly-schedule.ts). A live-in worker has an
 * empty schedule: always there.
 */
export type WorkerSchedule = WeeklySchedule;

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
  return checkWeeklySchedule(raw, fields);
}
