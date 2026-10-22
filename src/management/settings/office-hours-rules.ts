import {
  sortedWindows,
  weeklyStatus,
  weeklyWindowProblems,
  windowCode,
  type WeeklyWindowProblem,
} from '../../core/common/slots/weekly-windows';

export {
  END_MINUTE,
  START_MINUTE,
  WEEKDAY,
} from '../../core/common/slots/weekly-windows';
/** A compound's whole set: at most four windows a day. */
export const MAX_WINDOWS = 28;

export type OfficeHoursProblem = WeeklyWindowProblem;

/**
 * What is wrong with a set of office hours (ADR 0039), by position: a window
 * that does not end after it starts, and a window that overlaps an earlier
 * one of the same weekday. Two windows may touch (09:00–12:00, 12:00–17:00).
 * The rule of every weekly set (ADR 0044 moved it to core).
 */
export const officeHoursProblems = weeklyWindowProblems;

export { sortedWindows, windowCode };

/**
 * Whether the office is open at `now`, until when, and when it next opens
 * (ADR 0058): the status of every weekly set, in core beside `openAt`.
 */
export const officeStatus = weeklyStatus;
