// ============================================================================
// Weekly windows
// ============================================================================
//
// Hours that repeat every week, in the compound's time zone: a weekday
// (0 is Sunday) and minutes after local midnight, ending on the same day.
// The management's office hours (ADR 0039) and a facility's opening hours
// and peak times (ADR 0044) are sets of them. Pure functions: the services
// and the dashboard's forms say the same.

import {
  addDays,
  localDate,
  localParts,
  slotsOfDay,
  weekdayOf,
  zonedInstant,
  type LocalDate,
  type Slot,
} from './day-slots';

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

/**
 * Whether the windows hold `instant`: a window of its local weekday holds
 * its local minute, the end excluded. A place open all day has 0–1440; one
 * open past midnight has a window to 1440 and the next day's from 0, which
 * join (ADR 0060). Read on the local clock, so a clock change moves
 * nothing.
 */
export function openAt(
  windows: readonly WeeklyWindow[],
  instant: Date,
  timeZone: string,
): boolean {
  const { date, minute } = localParts(instant, timeZone);
  const weekday = weekdayOf(date);
  return windows.some(
    (w) =>
      w.weekday === weekday && w.startMinute <= minute && minute < w.endMinute,
  );
}

/**
 * Whether the windows are open at some moment of tonight still ahead:
 * between `lateFromMinute` (or now, when later) and the local midnight
 * that ends `instant`'s day (ADR 0060's "open late tonight"). A place that
 * closes exactly at `lateFromMinute` is not.
 */
export function openLateTonight(
  windows: readonly WeeklyWindow[],
  instant: Date,
  timeZone: string,
  lateFromMinute: number,
): boolean {
  const { date, minute } = localParts(instant, timeZone);
  const weekday = weekdayOf(date);
  const from = Math.max(minute, lateFromMinute);
  return windows.some((w) => w.weekday === weekday && w.endMinute > from);
}

/**
 * Whether the windows are open at `now`, until when, and when they next
 * open, in the compound's time zone: within the coming week. Touching
 * windows (09:00–12:00, 12:00–17:00), and a window to 24:00 with the next
 * day's from 00:00, count as one stretch. The office's status (ADR 0058);
 * `openAt` says the same open-or-not on the local clock alone (ADR 0060).
 */
export function weeklyStatus(
  windows: readonly WeeklyWindow[],
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
