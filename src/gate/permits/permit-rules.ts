import type { PermitSettings } from '@prisma/client';
import {
  localParts,
  weekdayOf,
  type LocalDate,
} from '../../core/common/slots/day-slots';

/**
 * The fixed limits of a unit's permits (ADR 0049). The compound sets only
 * its work days, hours and days off (permit_settings); these are the
 * product's.
 */
export const PERMIT_LIMITS = {
  /** Pending or approved and not ended, per unit and kind. */
  liveWorks: 3,
  liveMoves: 2,
  liveMaterialExits: 5,
  /** Pending or approved events of a unit that have not ended. */
  upcomingEvents: 3,
  /** Contractor workers on one works permit (removed ones not counted). */
  workersPerPermit: 30,
  /** An event of up to this many guests needs no approval. */
  eventGuestsWithoutApproval: 20,
  eventGuestsMax: 150,
  /** A works period, in local days, first and last included. */
  worksMaxDays: 180,
  /** A material exit's validity, in local days, first and last included. */
  materialExitMaxDays: 7,
  /** An event's window, in hours. */
  eventMaxHours: 24,
  /** How far ahead a permit may start, in days. */
  maxDaysAhead: 90,
  /** Dated days off a compound keeps. */
  daysOff: 100,
} as const;

/** `HH:MM`, 00:00 to 23:59. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes after midnight of an `HH:MM`. */
export function minuteOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** `HH:MM` of minutes after midnight. */
export function timeOf(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The compound's work rules, as the code reads them. */
export interface WorkRules {
  /** 0 = Sunday … 6 = Saturday, ascending. */
  workDays: number[];
  /** Minutes after local midnight; from < to. */
  workFrom: number;
  workTo: number;
  /** Local `YYYY-MM-DD`, ascending. */
  daysOff: LocalDate[];
}

export function workRules(s: PermitSettings): WorkRules {
  return {
    workDays: [...s.workDays].sort((a, b) => a - b),
    workFrom: s.workFrom,
    workTo: s.workTo,
    daysOff: s.daysOff.map((d) => d.toISOString().slice(0, 10)).sort(),
  };
}

/** Whether works and moves may take place on a local day. */
export function isWorkDay(rules: WorkRules, date: LocalDate): boolean {
  return (
    rules.workDays.includes(weekdayOf(date)) && !rules.daysOff.includes(date)
  );
}

/**
 * Why works may not take place at `instant` under the compound's rules, or
 * null when they may. A day off or a week day off is `day_off`; a time
 * outside the hours of a work day is `outside_work_hours`.
 */
export function workTimeRefusal(
  rules: WorkRules,
  instant: Date,
  timeZone: string,
): 'day_off' | 'outside_work_hours' | null {
  const { date, minute } = localParts(instant, timeZone);
  if (!isWorkDay(rules, date)) return 'day_off';
  if (minute < rules.workFrom || minute >= rules.workTo)
    return 'outside_work_hours';
  return null;
}
