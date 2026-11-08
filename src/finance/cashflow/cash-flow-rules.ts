import { Prisma } from '@prisma/client';
import {
  addDays,
  weekdayOf,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import {
  addMonths,
  periodHolding,
  type PlanTerms,
} from '../billing-plans/periods';
import { retentionOf } from '../payables/payable-rules';

// ============================================================================
// Cash flow and liquidity (ADR 0091): the rules, without the database
// ============================================================================

/** How the forecast cuts its horizon. */
export const CASH_FLOW_BY = ['week', 'month'] as const;
export type CashFlowBy = (typeof CASH_FLOW_BY)[number];

/** How many periods it shows, this one first: 13 weeks, or 6 months, by default. */
export const CASH_FLOW_PERIODS: Record<
  CashFlowBy,
  { min: number; max: number; default: number }
> = {
  week: { min: 1, max: 26, default: 13 },
  month: { min: 1, max: 12, default: 6 },
};

/**
 * The window the collection rate and the daily spending are read over: the
 * 90 of the compound's days before today (today, still under way, aside).
 */
export const WINDOW_DAYS = 90;

/** A new dip within this long of the last notice waits until it is up. */
export const CASH_LOW_QUIET_MS = 24 * 60 * 60_000;

/** The largest floor: what DECIMAL(14,2) holds. */
export const CASH_MINIMUM = /^(?!0+(\.0{1,2})?$)\d{1,12}(\.\d{1,2})?$/;

/** A period of the forecast: its first and last days, both included. */
export interface CashFlowPeriod {
  from: LocalDate;
  to: LocalDate;
}

/** The window before `today`: its first and last days. */
export function windowBefore(today: LocalDate): CashFlowPeriod {
  return { from: addDays(today, -WINDOW_DAYS), to: addDays(today, -1) };
}

/**
 * The forecast's periods from `today`: the compound's weeks, Saturday to
 * Friday (its weekend Friday, as the reports' weeks, ADR 0086), or its
 * calendar months. The first starts today and ends with its week or month,
 * so it may be short; the others are whole.
 */
export function periodsFrom(
  by: CashFlowBy,
  count: number,
  today: LocalDate,
): CashFlowPeriod[] {
  const out: CashFlowPeriod[] = [];
  let from = today;
  for (let i = 0; i < count; i++) {
    const to =
      by === 'week'
        ? addDays(from, (5 - weekdayOf(from) + 7) % 7)
        : addDays(addMonths(`${from.slice(0, 7)}-01`, 1), -1);
    out.push({ from, to });
    from = addDays(to, 1);
  }
  return out;
}

/**
 * The period a day falls in: one before the first (overdue) falls in the
 * first, one after the last in none (-1).
 */
export function periodIndex(
  periods: readonly CashFlowPeriod[],
  day: LocalDate,
): number {
  if (!periods.length || day > periods[periods.length - 1].to) return -1;
  if (day < periods[0].from) return 0;
  return periods.findIndex((p) => day >= p.from && day <= p.to);
}

/**
 * The collection rate (ADR 0091): of what the invoices due in the window
 * asked after their credit notes, the share paid of it so far (live
 * allocations, net of releases; a payment reversed counts nothing), from 0
 * to 1 to three places. Null with nothing due in the window: no history.
 */
export function collectionRate(
  due: Prisma.Decimal.Value,
  collected: Prisma.Decimal.Value,
): number | null {
  const d = new Prisma.Decimal(due);
  if (d.lte(0)) return null;
  const share = new Prisma.Decimal(collected)
    .div(d)
    .toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);
  return Math.min(1, Math.max(0, share.toNumber()));
}

/**
 * What the residents' dues of a period are expected to bring at the rate,
 * to the piastre; nothing without a rate (no history: the forecast counts
 * on no resident money it has no record of collecting).
 */
export function expectedOf(
  dues: Prisma.Decimal.Value,
  rate: number | null,
): Prisma.Decimal {
  if (rate === null) return new Prisma.Decimal(0);
  return new Prisma.Decimal(dues)
    .mul(rate)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Days of spending the cash covers (ADR 0091): the cash on hand over the
 * window's average daily spending, whole days (rounded down); 0 at no
 * cash. Null when it cannot be computed: no live account to hold cash, or
 * nothing spent in the window.
 */
export function liquidityDays(
  cash: Prisma.Decimal.Value,
  spent: Prisma.Decimal.Value,
  hasAccounts: boolean,
): number | null {
  const s = new Prisma.Decimal(spent);
  if (!hasAccounts || s.lte(0)) return null;
  const c = new Prisma.Decimal(cash);
  if (c.lte(0)) return 0;
  return c.mul(WINDOW_DAYS).div(s).floor().toNumber();
}

/** The average daily spending of the window, to the piastre. */
export function dailySpending(spent: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(spent)
    .div(WINDOW_DAYS)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * A contract's payment split as a payout pays it (ADR 0089): what leaves
 * now, and the retention held back until the contract's end.
 */
export function splitRetention(
  amount: Prisma.Decimal.Value,
  pct: Prisma.Decimal.Value | null,
): { now: Prisma.Decimal; held: Prisma.Decimal } {
  const held = new Prisma.Decimal(retentionOf(amount, pct));
  return { now: new Prisma.Decimal(amount).sub(held), held };
}

/**
 * The periods a billing plan will still bill (ADR 0069's projection, the
 * billing sweep's periods read ahead): each from the one holding `today`
 * on, with its nominal due day (its issue day, then the days to pay), up
 * to `lastDueOn`.
 */
export function planPeriods(
  terms: PlanTerms & { dueDaysAfterIssue: number },
  frequencyMonths: number,
  today: LocalDate,
  lastDueOn: LocalDate,
): { start: LocalDate; dueOn: LocalDate }[] {
  let start = periodHolding(terms, today)?.start ?? terms.startsOn;
  const out: { start: LocalDate; dueOn: LocalDate }[] = [];
  for (let i = 0; i < 400; i++) {
    const dueOn = addDays(
      addDays(start, -terms.issueDaysBefore),
      terms.dueDaysAfterIssue,
    );
    if (dueOn > lastDueOn) break;
    out.push({ start, dueOn });
    start = addMonths(start, frequencyMonths);
  }
  return out;
}

/** Each period's closing balance: the opening plus every net up to it. */
export function closings(
  opening: Prisma.Decimal.Value,
  nets: readonly Prisma.Decimal.Value[],
): Prisma.Decimal[] {
  let balance = new Prisma.Decimal(opening);
  return nets.map((n) => (balance = balance.add(n)));
}
