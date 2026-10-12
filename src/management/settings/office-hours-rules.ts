import type { OfficeWindow } from './defaults';

export const WEEKDAY = { min: 0, max: 6 } as const;
export const START_MINUTE = { min: 0, max: 1439 } as const;
export const END_MINUTE = { min: 1, max: 1440 } as const;
/** A compound's whole set: at most four windows a day. */
export const MAX_WINDOWS = 28;

export type OfficeHoursProblem =
  | { index: number; problem: 'ends_before_start' }
  | { index: number; problem: 'overlaps'; other: number };

/**
 * What is wrong with a set of office hours (ADR 0039), by position: a window
 * that does not end after it starts, and a window that overlaps an earlier
 * one of the same weekday. Two windows may touch (09:00–12:00, 12:00–17:00).
 * Pure: the service and the dashboard's form say the same.
 */
export function officeHoursProblems(
  windows: readonly OfficeWindow[],
): OfficeHoursProblem[] {
  const problems: OfficeHoursProblem[] = [];
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

/** By weekday, then start: how the set is stored, returned and audited. */
export function sortedWindows<T extends OfficeWindow>(
  windows: readonly T[],
): T[] {
  return [...windows].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
  );
}

/** `2:540-1020`: a window as the audit trail records it (numbers only). */
export const windowCode = (w: OfficeWindow) =>
  `${w.weekday}:${w.startMinute}-${w.endMinute}`;
