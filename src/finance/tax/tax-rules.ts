import { Prisma } from '@prisma/client';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';

// ============================================================================
// Taxes (ADR 0093): VAT on what the compound bills and the input VAT it
// recovers, a monthly declaration, and withholding tax on vendor payments.
// Every rate and rule is a compound setting with an Egyptian default; what
// is here is the arithmetic, to the piastre, half up.
// ============================================================================

type Money = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);
const round = (v: Money) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** The categories a vendor's payment withholds by; `exempt` withholds nothing. */
export const WITHHOLDING_CATEGORIES = [
  'supplies',
  'services',
  'professional',
  'exempt',
] as const;
export type WithholdingCategory = (typeof WITHHOLDING_CATEGORIES)[number];

/** The kinds of tax paid to the tax authority. */
export const TAX_PAYMENT_KINDS = ['vat', 'withholding'] as const;
export type TaxPaymentKind = (typeof TAX_PAYMENT_KINDS)[number];

/** The defaults (the owner's decision of 2026-11-10: Egypt's common scheme). */
export const TAX_DEFAULTS = {
  vatRate: '14.00',
  withholding: { supplies: '1.00', services: '3.00', professional: '5.00' },
  withholdingThreshold: '300.00',
} as const;

export const TAX_LIMITS = {
  vatNumber: 30,
  reference: 100,
} as const;

/** A rate in percent: above 0 (VAT) or from 0 (withholding), at most 100, two decimals. */
export const RATE = /^\d{1,3}(\.\d{1,2})?$/;

/** A line's VAT at a rate. */
export function vatOf(
  amount: Prisma.Decimal.Value,
  rate: Prisma.Decimal.Value,
): Money {
  return round(new Prisma.Decimal(amount).mul(rate).div(100));
}

/**
 * Gross amounts split into net and VAT by a share of VAT taken from
 * another invoice (an instalment plan's, ADR 0048): each its rounded share,
 * the last the rest, so the VAT adds up to `vat` exactly.
 */
export function splitVat(
  grosses: readonly Money[],
  vat: Money,
): { net: Money; vat: Money }[] {
  const total = grosses.reduce((s, g) => s.add(g), ZERO);
  if (vat.eq(ZERO) || total.eq(ZERO))
    return grosses.map((g) => ({ net: g, vat: ZERO }));
  let left = vat;
  return grosses.map((g, i) => {
    const v = i === grosses.length - 1 ? left : round(g.mul(vat).div(total));
    left = left.sub(v);
    return { net: g.sub(v), vat: v };
  });
}

/**
 * What a payout withholds: nothing when withholding is off, the category
 * is exempt, or the invoice's subtotal is below the threshold; else the
 * category's rate on the subtotal.
 */
export function withholdingOf(input: {
  enabled: boolean;
  category: WithholdingCategory;
  base: Prisma.Decimal.Value;
  rates: Record<Exclude<WithholdingCategory, 'exempt'>, Prisma.Decimal.Value>;
  threshold: Prisma.Decimal.Value;
}): {
  amount: Money;
  rate: Money;
  base: Money;
  category: Exclude<WithholdingCategory, 'exempt'> | null;
} {
  const base = new Prisma.Decimal(input.base);
  const none = { amount: ZERO, rate: ZERO, base: ZERO, category: null };
  if (!input.enabled || input.category === 'exempt') return none;
  if (base.lt(input.threshold) || base.lte(ZERO)) return none;
  const rate = new Prisma.Decimal(input.rates[input.category]);
  const amount = round(base.mul(rate).div(100));
  if (amount.lte(ZERO)) return none;
  return {
    amount,
    rate,
    base,
    category: input.category,
  };
}

/** A vendor's category by its trades, when none was set (ADR 0077's). */
export function categoryByTrades(
  trades: readonly string[],
): WithholdingCategory {
  if (trades.includes('professional')) return 'professional';
  if (trades.length === 1 && trades[0] === 'supplies') return 'supplies';
  return 'services';
}

/**
 * A month's declaration from its output and input VAT and what the month
 * before carried forward: due, or carried forward, never both.
 */
export function declarationOf(input: {
  output: Money;
  input: Money;
  carriedIn: Money;
}): { netDue: Money; carriedOut: Money } {
  const position = input.output.sub(input.input).sub(input.carriedIn);
  return position.gte(ZERO)
    ? { netDue: position, carriedOut: ZERO }
    : { netDue: ZERO, carriedOut: position.neg() };
}

/** The calendar quarter's first day of a day: withholding is reported by quarter. */
export function quarterOf(day: LocalDate): LocalDate {
  const m = Number(day.slice(5, 7));
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return `${day.slice(0, 4)}-${String(q).padStart(2, '0')}-01`;
}

/** A quarter's last day. */
export function quarterEnd(first: LocalDate): LocalDate {
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7));
  const next =
    m === 10 ? `${y + 1}-01-01` : `${y}-${String(m + 3).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

/** `2026-Q3`, or a quarter's first day back from it. */
export const QUARTER = /^\d{4}-Q[1-4]$/;
export function quarterLabel(first: LocalDate): string {
  return `${first.slice(0, 4)}-Q${(Number(first.slice(5, 7)) - 1) / 3 + 1}`;
}
export function quarterFirst(label: string): LocalDate {
  const q = Number(label.slice(6));
  return `${label.slice(0, 4)}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
}

/**
 * A fiscal year (ADR 0055's start month) by a day in it: its first and
 * last days.
 */
export function fiscalYearAround(
  day: LocalDate,
  startMonth: number,
): { startsOn: LocalDate; endsOn: LocalDate } {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const year = m >= startMonth ? y : y - 1;
  const mm = String(startMonth).padStart(2, '0');
  return {
    startsOn: `${year}-${mm}-01`,
    endsOn: addDays(`${year + 1}-${mm}-01`, -1),
  };
}

/** The fiscal year that starts on `startsOn`: its last day. */
export const fiscalYearEnd = (startsOn: LocalDate): LocalDate =>
  addDays(`${Number(startsOn.slice(0, 4)) + 1}${startsOn.slice(4)}`, -1);
