import { Prisma } from '@prisma/client';

/** What a ticket's cost entry is (ADR 0065); `part` is the store's alone. */
export const COST_KINDS = ['labour', 'contractor', 'part', 'other'] as const;
export type CostKind = (typeof COST_KINDS)[number];
/** What dispatch records by hand. */
export const RECORDED_COST_KINDS = ['labour', 'contractor', 'other'] as const;
export type RecordedCostKind = (typeof RECORDED_COST_KINDS)[number];

/** A positive quantity, three decimals at most, below a billion. */
export const QUANTITY = /^(?!0+(\.0{1,3})?$)\d{1,9}(\.\d{1,3})?$/;
/** EGP, zero or more, two decimals at most, below ten million. */
export const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
export const COST_DESCRIPTION_MAX = 200;

/**
 * quantity × unit amount to the piastre, half away from zero, as the
 * migration's CHECK computes it (`round(quantity * unit_amount, 2)`).
 */
export function costAmount(
  quantity: Prisma.Decimal.Value,
  unitAmount: Prisma.Decimal.Value,
): Prisma.Decimal {
  return new Prisma.Decimal(quantity)
    .times(unitAmount)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export interface CostTotals {
  /** Everything not voided, parts net of returns. */
  total: string;
  labour: string;
  contractor: string;
  parts: string;
  other: string;
}

/** A ticket's live entries summed by kind, as two-decimal strings. */
export function costTotals(
  entries: readonly {
    kind: string;
    amount: Prisma.Decimal;
    voidedAt: Date | null;
  }[],
): CostTotals {
  const sum = (kind?: CostKind) =>
    entries
      .filter((e) => e.voidedAt === null && (!kind || e.kind === kind))
      .reduce((a, e) => a.plus(e.amount), new Prisma.Decimal(0))
      .toFixed(2);
  return {
    total: sum(),
    labour: sum('labour'),
    contractor: sum('contractor'),
    parts: sum('part'),
    other: sum('other'),
  };
}
