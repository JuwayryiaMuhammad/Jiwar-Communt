import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);
const money = (d: Prisma.Decimal) =>
  d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** What the rule advises for an asset (ADR 0065): never a model, two rules. */
export const REPLACEMENT_ADVICE = ['replace', 'repair', 'unknown'] as const;
export type ReplacementAdvice = (typeof REPLACEMENT_ADVICE)[number];
/** Why: each rule that holds, by code. */
export const ADVICE_REASONS = [
  'repairs_exceed_replacement',
  'past_life_and_costly',
  'no_replacement_cost',
] as const;
export type AdviceReason = (typeof ADVICE_REASONS)[number];

/**
 * Repair or replace (ADR 0065): replace once all its repairs together cost
 * what a new one would, or once it is past its expected life and the last
 * twelve months' repairs cost `sharePct` % of a new one. Without a
 * replacement cost there is nothing to weigh.
 */
export function replacementAdvice(a: {
  replacementCost: Prisma.Decimal | null;
  cumulative: Prisma.Decimal;
  lastYear: Prisma.Decimal;
  ageYears: number | null;
  lifeYears: number | null;
  sharePct: number;
}): { advice: ReplacementAdvice; reasons: AdviceReason[] } {
  if (a.replacementCost === null || a.replacementCost.lte(ZERO))
    return { advice: 'unknown', reasons: ['no_replacement_cost'] };
  const reasons: AdviceReason[] = [];
  if (a.cumulative.gte(a.replacementCost))
    reasons.push('repairs_exceed_replacement');
  if (
    a.ageYears !== null &&
    a.lifeYears !== null &&
    a.ageYears >= a.lifeYears &&
    a.lastYear.gte(a.replacementCost.times(a.sharePct).dividedBy(100))
  )
    reasons.push('past_life_and_costly');
  return { advice: reasons.length ? 'replace' : 'repair', reasons };
}

/**
 * The straight-line reserve for one asset (ADR 0065): a new one's cost
 * spread over its expected life — what to set aside a year — and what has
 * built up by its age (never more than the cost).
 */
export function straightLineReserve(a: {
  replacementCost: Prisma.Decimal | null;
  ageYears: number | null;
  lifeYears: number | null;
}): { annual: Prisma.Decimal; accrued: Prisma.Decimal } | null {
  if (a.replacementCost === null || a.lifeYears === null || a.lifeYears <= 0)
    return null;
  const annual = a.replacementCost.dividedBy(a.lifeYears);
  const share = Math.min(Math.max(a.ageYears ?? 0, 0) / a.lifeYears, 1);
  return {
    annual: money(annual),
    accrued: money(a.replacementCost.times(share)),
  };
}

/**
 * The year a new one is due (ADR 0065): commissioned plus its expected
 * life; null when either is unknown.
 */
export function replacementYear(
  commissionedYear: number | null,
  lifeYears: number | null,
): number | null {
  return commissionedYear === null || lifeYears === null
    ? null
    : commissionedYear + lifeYears;
}

/**
 * Five years of replacements from `fromYear` (ADR 0065): each asset's
 * replacement cost in the year it falls due, one already overdue counted in
 * the first year.
 */
export function capitalPlan(
  assets: readonly {
    dueYear: number | null;
    replacementCost: Prisma.Decimal | null;
  }[],
  fromYear: number,
  years = 5,
): { year: number; amount: Prisma.Decimal; assets: number }[] {
  const plan = Array.from({ length: years }, (_, i) => ({
    year: fromYear + i,
    amount: ZERO,
    assets: 0,
  }));
  for (const a of assets) {
    if (a.dueYear === null || a.replacementCost === null) continue;
    const at = Math.max(a.dueYear, fromYear) - fromYear;
    if (at >= years) continue;
    plan[at].amount = plan[at].amount.plus(a.replacementCost);
    plan[at].assets += 1;
  }
  return plan;
}

/** Days between two instants, as a fraction, never negative. */
export function daysBetween(from: Date, to: Date): number {
  // A duration between two instants in 24-hour days: downtime is time out
  // of order, not the compound's calendar days.
  return Math.max(0, (to.getTime() - from.getTime()) / 86_400_000);
}

/** Downtime's cost: days out of order × the asset's cost of a day. */
export function downtimeCost(
  days: number,
  perDay: Prisma.Decimal | null,
): Prisma.Decimal | null {
  return perDay === null ? null : money(perDay.times(days));
}

/** A share as a fraction to four places, null when there is nothing to share. */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;
}
