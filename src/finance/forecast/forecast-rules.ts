import { Prisma } from '@prisma/client';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import {
  addMonths,
  periodHolding,
  type PlanTerms,
} from '../billing-plans/periods';

/** The most months ahead a forecast reads (ADR 0069). */
export const FORECAST_MONTHS = { min: 1, max: 6, default: 3 } as const;
/** Next month rises when it asks this many times the months before it. */
export const RISING_FACTOR = new Prisma.Decimal('1.5');
/** The months before it read, and how many must have asked something. */
export const RISING_PAST_MONTHS = 6;
export const RISING_MIN_MONTHS = 3;

const MONTHS_OF: Record<PlanTerms['frequency'], number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

export const monthOf = (d: LocalDate) => d.slice(0, 7);

/** `YYYY-MM`, `n` months on. */
export const monthPlus = (month: string, n: number) =>
  addMonths(`${month}-01`, n).slice(0, 7);

/**
 * The invoices a plan will issue to a unit (ADR 0069): each period from
 * the one holding `today` on, not issued to it yet, due (its issue day,
 * then the days to pay) up to `lastDueOn`. The same periods the billing
 * sweep bills, read ahead.
 */
export function projectedDues(
  terms: PlanTerms & { dueDaysAfterIssue: number },
  amount: Prisma.Decimal,
  issued: ReadonlySet<LocalDate>,
  today: LocalDate,
  lastDueOn: LocalDate,
): { dueOn: LocalDate; amount: Prisma.Decimal }[] {
  const step = MONTHS_OF[terms.frequency];
  let start = periodHolding(terms, today)?.start ?? terms.startsOn;
  const out: { dueOn: LocalDate; amount: Prisma.Decimal }[] = [];
  for (let i = 0; i < 400; i++) {
    const dueOn = addDays(
      addDays(start, -terms.issueDaysBefore),
      terms.dueDaysAfterIssue,
    );
    if (dueOn > lastDueOn) break;
    if (!issued.has(start)) out.push({ dueOn, amount });
    start = addMonths(start, step);
  }
  return out;
}

/**
 * Whether next month rises (ADR 0069): it asks more than RISING_FACTOR
 * times the mean of the months before it, read only with at least
 * RISING_MIN_MONTHS of them asking anything.
 */
export function rising(
  next: Prisma.Decimal,
  past: readonly Prisma.Decimal[],
): boolean {
  const asked = past.filter((m) => m.gt(0));
  if (asked.length < RISING_MIN_MONTHS) return false;
  const mean = past
    .reduce((s, m) => s.plus(m), new Prisma.Decimal(0))
    .dividedBy(past.length);
  return mean.gt(0) && next.gt(mean.times(RISING_FACTOR));
}
