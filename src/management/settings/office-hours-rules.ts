import {
  sortedWindows,
  weeklyWindowProblems,
  windowCode,
  type WeeklyWindowProblem,
} from '../../core/common/slots/weekly-windows';
import {
  addDays,
  localDate,
  weekdayOf,
  zonedInstant,
} from '../../core/common/slots/day-slots';
import type { OfficeWindow } from './defaults';

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
 * (ADR 0058), in the compound's time zone: within the coming week. Touching
 * windows (09:00–12:00, 12:00–17:00) count as one stretch.
 */
export function officeStatus(
  windows: readonly OfficeWindow[],
  now: Date,
  timeZone: string,
): { openNow: boolean; closesAt: Date | null; nextOpensAt: Date | null } {
  const today = localDate(now, timeZone);
  const spans: [number, number][] = [];
  for (let d = -1; d <= 7; d++) {
    const date = addDays(today, d);
    for (const w of windows.filter((x) => x.weekday === weekdayOf(date))) {
      const start = zonedInstant(date, w.startMinute, timeZone);
      const end =
        w.endMinute === 1440
          ? zonedInstant(addDays(date, 1), 0, timeZone)
          : zonedInstant(date, w.endMinute, timeZone);
      if (start && end && end > start)
        spans.push([start.getTime(), end.getTime()]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  // Merge touching or overlapping stretches.
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const t = now.getTime();
  const open = merged.find(([a, b]) => a <= t && t < b);
  const next = merged.find(([a]) => a > t);
  return {
    openNow: !!open,
    closesAt: open ? new Date(open[1]) : null,
    nextOpensAt: next ? new Date(next[0]) : null,
  };
}
