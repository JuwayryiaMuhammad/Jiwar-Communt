// ============================================================================
// Weekly windows
// ============================================================================
//
// Hours that repeat every week, in the compound's time zone: a weekday
// (0 is Sunday) and minutes after local midnight, ending on the same day.
// The management's office hours (ADR 0039) and a facility's opening hours
// and peak times (ADR 0044) are sets of them. Pure functions: the services
// and the dashboard's forms say the same.

import { slotsOfDay, weekdayOf, type LocalDate, type Slot } from './day-slots';

export interface WeeklyWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export const WEEKDAY = { min: 0, max: 6 } as const;
export const START_MINUTE = { min: 0, max: 1439 } as const;
export const END_MINUTE = { min: 1, max: 1440 } as const;

export type WeeklyWindowProblem =
  | { index: number; problem: 'ends_before_start' }
  | { index: number; problem: 'overlaps'; other: number };

/**
 * What is wrong with a set of windows, by position: a window that does not
 * end after it starts, and a window that overlaps an earlier one of the
 * same weekday. Two windows may touch (09:00–12:00, 12:00–17:00).
 */
export function weeklyWindowProblems(
  windows: readonly WeeklyWindow[],
): WeeklyWindowProblem[] {
  const problems: WeeklyWindowProblem[] = [];
  windows.forEach((w, index) => {
    if (w.endMinute <= w.startMinute) {
      problems.push({ index, problem: 'ends_before_start' });
      return;
    }
    const other = windows.findIndex(
      (o, i) =>
        i < index &&
        o.weekday === w.weekday &&
        o.endMinute > o.startMinute &&
        o.startMinute < w.endMinute &&
        w.startMinute < o.endMinute,
    );
    if (other >= 0) problems.push({ index, problem: 'overlaps', other });
  });
  return problems;
}

/**
 * The positions of the `inner` windows that some `outer` window of their
 * weekday does not cover, minute for minute: a peak time outside a
 * facility's hours. Touching outer windows cover as one.
 */
export function uncoveredWindows(
  inner: readonly WeeklyWindow[],
  outer: readonly WeeklyWindow[],
): number[] {
  const out: number[] = [];
  inner.forEach((w, index) => {
    let reached = w.startMinute;
    for (const o of sortedWindows(
      outer.filter((x) => x.weekday === w.weekday),
    )) {
      if (o.startMinute > reached) break;
      reached = Math.max(reached, o.endMinute);
      if (reached >= w.endMinute) break;
    }
    if (reached < w.endMinute) out.push(index);
  });
  return out;
}

/** By weekday, then start: how a set is stored, returned and audited. */
export function sortedWindows<T extends WeeklyWindow>(
  windows: readonly T[],
): T[] {
  return [...windows].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
  );
}

/** `2:540-1020`: a window as the audit trail records it (numbers only). */
export const windowCode = (w: WeeklyWindow) =>
  `${w.weekday}:${w.startMinute}-${w.endMinute}`;

/** The slots of one local day: the windows of its weekday, each cut. */
export function weeklySlotsOfDay(
  date: LocalDate,
  windows: readonly WeeklyWindow[],
  slotMinutes: number,
  timeZone: string,
): Slot[] {
  const weekday = weekdayOf(date);
  return sortedWindows(windows.filter((w) => w.weekday === weekday)).flatMap(
    (w) =>
      slotsOfDay(
        date,
        {
          startMinute: w.startMinute,
          endMinute: w.endMinute,
          slotMinutes,
        },
        timeZone,
      ),
  );
}
