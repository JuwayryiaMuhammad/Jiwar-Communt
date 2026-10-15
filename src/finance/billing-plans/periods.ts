import type { BillingFrequency } from '@prisma/client';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';

/** A period a plan bills: from its first day to `end`, excluded. */
export interface Period {
  start: LocalDate;
  end: LocalDate;
}

export interface PlanTerms {
  frequency: BillingFrequency;
  /** The first day of the first period: the first of a month. */
  startsOn: LocalDate;
  issueDaysBefore: number;
}

const MONTHS: Record<BillingFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/** The first of the month `n` months after a first of the month. */
export function addMonths(firstOfMonth: LocalDate, n: number): LocalDate {
  const [y, m] = firstOfMonth.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** The plan's period that holds `day`, or null before the plan starts. */
export function periodHolding(terms: PlanTerms, day: LocalDate): Period | null {
  if (day < terms.startsOn) return null;
  const step = MONTHS[terms.frequency];
  const [sy, sm] = terms.startsOn.split('-').map(Number);
  const [dy, dm] = day.split('-').map(Number);
  const months = (dy - sy) * 12 + (dm - sm);
  const start = addMonths(terms.startsOn, Math.floor(months / step) * step);
  return { start, end: addMonths(start, step) };
}

/**
 * The periods to bill on `today` (ADR 0046): the one that holds today
 * (a unit added since its issue, or a plan created during it, is billed for
 * it; nothing earlier is caught up), and the next one once today is within
 * `issueDaysBefore` days of its start.
 */
export function periodsToBill(terms: PlanTerms, today: LocalDate): Period[] {
  const out: Period[] = [];
  const current = periodHolding(terms, today);
  if (current) out.push(current);
  const next = current
    ? {
        start: current.end,
        end: addMonths(current.end, MONTHS[terms.frequency]),
      }
    : {
        start: terms.startsOn,
        end: addMonths(terms.startsOn, MONTHS[terms.frequency]),
      };
  if (today >= addDays(next.start, -terms.issueDaysBefore)) out.push(next);
  return out;
}

/** How a plan's invoice names its period: first and last day. */
export function periodLabel(p: Period): string {
  return `${p.start} – ${addDays(p.end, -1)}`;
}
