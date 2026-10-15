import { Prisma } from '@prisma/client';

export const CURRENCY = 'EGP';

/** A positive EGP amount of at most 1,000,000 with two decimals at most. */
export const MONEY = /^(?!0+(\.0{1,2})?$)\d{1,7}(\.\d{1,2})?$/;
export const MAX_AMOUNT = new Prisma.Decimal(1_000_000);

export const money = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/** As the API shows amounts: a decimal string with two places. */
export const show = (v: Prisma.Decimal.Value) => money(v).toFixed(2);

/** Whole piastres, as Paymob takes amounts. */
export function toCents(v: Prisma.Decimal.Value): number {
  const cents = money(v).mul(100);
  if (!cents.isInteger()) throw new Error('more than two decimals');
  return cents.toNumber();
}

export const ZERO = money(0);
