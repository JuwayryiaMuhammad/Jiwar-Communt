import { Prisma } from '@prisma/client';

/** The units an item is counted in (ADR 0065); the migration's CHECK repeats them. */
export const STOCK_UNITS = [
  'piece',
  'metre',
  'litre',
  'kilogram',
  'box',
  'set',
  'pair',
  'roll',
] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

export const MOVEMENT_KINDS = [
  'receive',
  'adjust',
  'transfer',
  'issue',
  'return',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const PART_REQUEST_STATUSES = [
  'requested',
  'reserved',
  'issued',
  'declined',
  'cancelled',
] as const;
export type PartRequestStatus = (typeof PART_REQUEST_STATUSES)[number];
/** Still the store's to act on; a reservation holds stock. */
export const OPEN_PART_REQUESTS: readonly PartRequestStatus[] = [
  'requested',
  'reserved',
];

/** A store's or an item's code, like the asset register's. */
export const STOCK_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** A signed, non-zero change of a level: three decimals at most. */
export const STOCK_DELTA = /^-?(?!0+(\.0{1,3})?$)\d{1,9}(\.\d{1,3})?$/;
/** Zero or more, three decimals: a reorder level. */
export const STOCK_LEVEL = /^\d{1,9}(\.\d{1,3})?$/;
export const REFERENCE_MAX = 60;

const ZERO = new Prisma.Decimal(0);

/**
 * The average cost after a receipt (ADR 0065): what the store held at the
 * old average, plus what came in at its cost, over the new total; to the
 * piastre. Nothing held, or no average yet, and it is the receipt's cost.
 */
export function averageAfterReceipt(
  held: Prisma.Decimal,
  average: Prisma.Decimal | null,
  received: Prisma.Decimal,
  unitCost: Prisma.Decimal,
): Prisma.Decimal {
  if (average === null || held.lte(ZERO))
    return unitCost.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return held
    .times(average)
    .plus(received.times(unitCost))
    .dividedBy(held.plus(received))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * What the reorder warning should be after a change (ADR 0065): sent once
 * when what the store holds of an item falls to its level or below, and
 * cleared once it is above again, so the next fall warns again. No level,
 * no warning.
 */
export function reorderState(
  held: Prisma.Decimal,
  level: Prisma.Decimal | null,
  alerted: boolean,
): 'warn' | 'clear' | 'keep' {
  if (level === null) return alerted ? 'clear' : 'keep';
  if (held.lte(level)) return alerted ? 'keep' : 'warn';
  return alerted ? 'clear' : 'keep';
}

/** What is free to reserve in a level. */
export const free = (l: {
  quantity: Prisma.Decimal;
  reserved: Prisma.Decimal;
}): Prisma.Decimal => l.quantity.minus(l.reserved);

/** A three-decimal string for a quantity. */
export const qty = (d: Prisma.Decimal): string => d.toFixed(3);
