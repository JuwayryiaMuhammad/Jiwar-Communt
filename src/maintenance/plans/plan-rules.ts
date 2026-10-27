import { addDays, type LocalDate } from '../schedules/local-dates';
import {
  firstOnOrAfter,
  intervalAfter,
  nextAfter,
  type Recurrence,
} from '../schedules/recurrence';

/**
 * Maintenance plans (ADR 0064): the closed lists (the migration's CHECKs
 * repeat them) and the date rules, pure.
 */
export const PLAN_TRIGGERS = ['calendar', 'usage'] as const;
export type PlanTrigger = (typeof PLAN_TRIGGERS)[number];
export const PLAN_BASES = ['fixed', 'floating'] as const;
export type PlanBasis = (typeof PLAN_BASES)[number];
export const OCCURRENCE_STATUSES = [
  'open',
  'done',
  'skipped',
  'cancelled',
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];
export const PLAN_DAYS = { min: 0, max: 60 };
export const PLAN_TITLE = { min: 1, max: 120 };
/** How far a due date may be deferred, in days from today. */
export const MAX_DEFER_DAYS = 366;

export interface CalendarSeries extends Recurrence {
  basis: PlanBasis;
}

/**
 * A new (or re-timed) calendar plan's first due date: the series' first
 * date on or after today, a fixed one; a floating one its anchor, or today
 * when the anchor has passed.
 */
export function firstDue(s: CalendarSeries, today: LocalDate): LocalDate {
  if (s.basis === 'floating') return s.anchorOn >= today ? s.anchorOn : today;
  return firstOnOrAfter(s, today);
}

/**
 * The next due date once `due` has its work order: a fixed series' next
 * date; none for a floating one, until the work is done (`afterDone`).
 */
export function afterGeneration(
  s: CalendarSeries,
  due: LocalDate,
): LocalDate | null {
  return s.basis === 'fixed' ? nextAfter(s, due) : null;
}

/** A floating series' next due date: one interval after the day it ended. */
export function afterDone(s: CalendarSeries, day: LocalDate): LocalDate {
  return intervalAfter(s, day);
}

/** Whether the work order is opened today: `lead` days before it is due. */
export const opensBy = (
  due: LocalDate,
  leadDays: number,
  today: LocalDate,
): boolean => addDays(due, -leadDays) <= today;

/** Done in time: by the due date plus the grace days, the compound's. */
export const onTime = (
  due: LocalDate,
  graceDays: number,
  doneOn: LocalDate,
): boolean => doneOn <= addDays(due, graceDays);

/** Past its grace: overdue, and worth one notice. */
export const overdue = (
  due: LocalDate,
  graceDays: number,
  today: LocalDate,
): boolean => today > addDays(due, graceDays);

/** A usage plan comes due when its metric grew by the interval since the last service. */
export const usageDue = (
  value: number,
  last: number | null,
  interval: number,
): boolean => value - (last ?? 0) >= interval;
