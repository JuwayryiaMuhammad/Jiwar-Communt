import { addDays, daysBetween, type LocalDate } from '../schedules/local-dates';

/** What the compound keeps valid (ADR 0087); the migration's CHECK repeats it. */
export const COMPLIANCE_KINDS = [
  'fire_system',
  'lift',
  'insurance',
  'licence',
  'permit',
  'other',
] as const;
export type ComplianceKind = (typeof COMPLIANCE_KINDS)[number];

/**
 * Where an item stands on the compound's today: its open due day beyond
 * its lead time (`valid`), within it (`due_soon`) or past (`overdue`); no
 * open due day left (`completed`: done once, nothing recurs); `retired`.
 */
export const COMPLIANCE_STATES = [
  'valid',
  'due_soon',
  'overdue',
  'completed',
  'retired',
] as const;
export type ComplianceState = (typeof COMPLIANCE_STATES)[number];

export const OCCURRENCE_STATUSES = ['open', 'done', 'cancelled'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** The compound's lead times with no settings row of its own, in days. */
export const DEFAULT_LEAD_DAYS: readonly number[] = [60, 30, 7];
export const LEAD_DAYS = { min: 1, max: 365, count: 3 } as const;
export const RECURRENCE_MONTHS = { min: 1, max: 120 } as const;
export const COMPLIANCE_LIMITS = {
  title: 120,
  authority: 120,
  notes: 1000,
  note: 1000,
} as const;
/** A licence's, a policy's or a certificate's number as written on it. */
export const COMPLIANCE_NUMBER = /^[A-Za-z0-9/. -]{1,60}$/;
/** Live evidence files a due day keeps at most. */
export const EVIDENCE_MAX = 20;
/** Files a completion attaches at once. */
export const COMPLETION_FILES_MAX = 10;
/** A completion is recorded at most this many days after it was done. */
export const DONE_DAYS_BACK = 366;
/** The calendar's window, and a due day's distance from today, at most. */
export const CALENDAR_MAX_DAYS = 366;
export const DUE_YEARS_AHEAD = 10;

/** The lead times in force: the item's own, else the compound's; longest first. */
export function leadTimes(
  own: readonly number[],
  compound: readonly number[],
): number[] {
  return normalLeads(own.length ? own : compound);
}

/** Distinct, longest first. */
export const normalLeads = (xs: readonly number[]): number[] =>
  [...new Set(xs)].sort((a, b) => b - a);

/** An open due day's state on `today`, with the lead times in force. */
export function stateOf(
  dueOn: LocalDate,
  today: LocalDate,
  leads: readonly number[],
): 'valid' | 'due_soon' | 'overdue' {
  if (dueOn < today) return 'overdue';
  const longest = leads.length ? Math.max(...leads) : 0;
  return daysBetween(today, dueOn) <= longest ? 'due_soon' : 'valid';
}

/**
 * The lead time a notice is due for now: the shortest lead time the days
 * left are within, when it is shorter than the last one told (or none was);
 * else null. Past the day: null (the overdue notice is its own).
 */
export function leadToTell(
  dueOn: LocalDate,
  today: LocalDate,
  leads: readonly number[],
  lastTold: number | null,
): number | null {
  const left = daysBetween(today, dueOn);
  if (left < 0) return null;
  const within = leads.filter((l) => left <= l);
  if (!within.length) return null;
  const stage = Math.min(...within);
  return lastTold === null || stage < lastTold ? stage : null;
}

/**
 * `date` plus `n` calendar months: the same day of the month, or the last
 * day of a shorter month (Jan 31 + 1 month = Feb 28, or 29).
 */
export function addMonths(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  const months = y * 12 + (m - 1) + n;
  const year = Math.floor(months / 12);
  const month = months % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The next due day once one is done (ADR 0087): the day it is given, else
 * the expiry of what was obtained, else so many months after the due day
 * just done; none for an item done once with nothing that expires.
 */
export function nextDueOn(input: {
  dueOn: LocalDate;
  recurrenceMonths: number | null;
  expiresOn?: LocalDate;
  nextDueOn?: LocalDate;
}): LocalDate | null {
  if (input.nextDueOn) return input.nextDueOn;
  if (input.expiresOn) return input.expiresOn;
  if (input.recurrenceMonths)
    return addMonths(input.dueOn, input.recurrenceMonths);
  return null;
}

/** The latest a due day may be: ten years from today. */
export const latestDue = (today: LocalDate): LocalDate =>
  addMonths(today, DUE_YEARS_AHEAD * 12);

/** The earliest day a completion may say it was done. */
export const earliestDone = (today: LocalDate): LocalDate =>
  addDays(today, -DONE_DAYS_BACK);
