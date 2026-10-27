import {
  addDays,
  dateColumn,
  ofDateColumn,
  type LocalDate,
} from './local-dates';

/**
 * How often something comes due on the compound's calendar (ADR 0064): a
 * maintenance plan, an inspection round. Every `every` days, weeks,
 * months or years from `anchorOn`. A month's step keeps the anchor's day,
 * clamped to the month's last (an anchor on 31 January comes due on 28 or
 * 29 February and 31 March, never drifting to the 28th). Dates only, never
 * instants: a DST change moves nothing.
 */
export const RECURRENCE_UNITS = ['day', 'week', 'month', 'year'] as const;
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];
export const RECURRENCE_EVERY = { min: 1, max: 365 };

export interface Recurrence {
  every: number;
  unit: RecurrenceUnit;
  anchorOn: LocalDate;
}

/** The k-th date from the anchor (k = 0 is the anchor). */
export function occurrence(r: Recurrence, k: number): LocalDate {
  if (r.unit === 'day') return addDays(r.anchorOn, k * r.every);
  if (r.unit === 'week') return addDays(r.anchorOn, 7 * k * r.every);
  const [y, m, d] = r.anchorOn.split('-').map(Number);
  const months = (r.unit === 'month' ? 1 : 12) * k * r.every;
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return ofDateColumn(new Date(Date.UTC(year, month, Math.min(d, last))));
}

/** The first date of the series on or after `from` (the anchor at the earliest). */
export function firstOnOrAfter(r: Recurrence, from: LocalDate): LocalDate {
  if (from <= r.anchorOn) return r.anchorOn;
  // An estimate of k from the days between, then a walk to the exact one.
  const days =
    (dateColumn(from).getTime() - dateColumn(r.anchorOn).getTime()) /
    86_400_000;
  const span =
    { day: 1, week: 7, month: 30.44, year: 365.25 }[r.unit] * r.every;
  let k = Math.max(0, Math.floor(days / span) - 1);
  while (occurrence(r, k) < from) k++;
  while (k > 0 && occurrence(r, k - 1) >= from) k--;
  return occurrence(r, k);
}

/** The date after `due` in a fixed series: the next one strictly later. */
export function nextAfter(r: Recurrence, due: LocalDate): LocalDate {
  return firstOnOrAfter(r, addDays(due, 1));
}

/** A floating series: one interval after the day the last one was done. */
export function intervalAfter(
  r: Omit<Recurrence, 'anchorOn'>,
  day: LocalDate,
): LocalDate {
  return occurrence({ ...r, anchorOn: day }, 1);
}
