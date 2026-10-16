// ============================================================================
// The guards' roster (ADR 0050): pure rules
// ============================================================================
//
// When a template's slots fall, when a shift is late or absent, and what
// its end records. The services decide by these, under their locks and by
// the database's clock.

import {
  addDays,
  weekdayOf,
  zonedInstant,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import {
  minutesOf,
  windowLength,
  type WeeklySchedule,
} from '../../core/common/slots/weekly-schedule';

const MINUTE = 60_000;

/** Opened more than this after the slot's start, a shift is late. */
export const LATE_AFTER_MINUTES = 10;
/** Not opened this long after the slot's start, the guard is absent. */
export const ABSENT_AFTER_MINUTES = 60;
/** A shift fills a slot opened from this long before its start until its end. */
export const LINK_EARLY_MINUTES = 30;
/** How far ahead templates are made into slots. */
export const HORIZON_DAYS = 28;
/** The longest period one read of the roster or the attendance covers. */
export const MAX_RANGE_DAYS = 31;
/** A slot lasts a day at most (CHECK). */
export const MAX_SLOT_MINUTES = 24 * 60;

export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

/**
 * The slots a weekly schedule makes on the compound's days `from` … `to`
 * (inclusive), within the template's own days. A window belongs to the day
 * it starts on, and lasts its length in real time across midnight and a
 * clock change. A start the clock skips (a DST gap) moves to the first
 * minute that exists.
 */
export function occurrences(
  schedule: WeeklySchedule,
  effective: { from: LocalDate; until: LocalDate | null },
  from: LocalDate,
  to: LocalDate,
  timeZone: string,
): Interval[] {
  const first = from > effective.from ? from : effective.from;
  const last =
    effective.until !== null && effective.until < to ? effective.until : to;
  const out: Interval[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    if (!schedule.days.includes(weekdayOf(day))) continue;
    for (const w of schedule.windows) {
      const startsAt = firstInstant(day, minutesOf(w.from), timeZone);
      if (!startsAt) continue;
      out.push({
        startsAt,
        endsAt: new Date(startsAt.getTime() + windowLength(w) * MINUTE),
      });
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

function firstInstant(
  day: LocalDate,
  minute: number,
  timeZone: string,
): Date | null {
  for (let m = minute; m < minute + 120 && m < 24 * 60; m++) {
    const at = zonedInstant(day, m, timeZone);
    if (at) return at;
  }
  return null;
}

/** Whether two intervals share an instant (touching ones do not). */
export const overlaps = (a: Interval, b: Interval) =>
  a.startsAt.getTime() < b.endsAt.getTime() &&
  b.startsAt.getTime() < a.endsAt.getTime();

/** Whole minutes from `a` to `b`, never below zero. */
export function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / MINUTE));
}

/** Minutes after the slot's start the shift opened (0 when on time or early). */
export const lateMinutesOf = (slotStart: Date, openedAt: Date) =>
  minutesBetween(slotStart, openedAt);

export const isLate = (lateMinutes: number | null) =>
  lateMinutes !== null && lateMinutes > LATE_AFTER_MINUTES;

/** Whether a shift opened at `at` fills this slot. */
export function fills(slot: Interval, at: Date): boolean {
  return (
    slot.startsAt.getTime() - LINK_EARLY_MINUTES * MINUTE <= at.getTime() &&
    at.getTime() < slot.endsAt.getTime()
  );
}

/**
 * What a shift's end records: overtime (minutes worked beyond the slot's
 * length) for a shift that filled a slot; its whole length as unscheduled
 * minutes, never overtime, for one that filled none.
 */
export function endMinutes(
  shift: { startedAt: Date; endedAt: Date },
  slot: Interval | null,
): { overtimeMinutes: number | null; unscheduledMinutes: number | null } {
  const worked = minutesBetween(shift.startedAt, shift.endedAt);
  if (!slot) return { overtimeMinutes: null, unscheduledMinutes: worked };
  const scheduled = minutesBetween(slot.startsAt, slot.endsAt);
  return {
    overtimeMinutes: Math.max(0, worked - scheduled),
    unscheduledMinutes: null,
  };
}

/** The days `from` … `to` inclusive, at most MAX_RANGE_DAYS. */
export function dayCount(from: LocalDate, to: LocalDate): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / (24 * 60 * MINUTE)) + 1;
}
