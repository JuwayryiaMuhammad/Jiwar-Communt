import { Prisma } from '@prisma/client';

/**
 * A line's tax code (ADR 0089) and its rate in percent. Zero by default:
 * whether a compound's purchases carry VAT is the owner's and the
 * accountant's answer (the plan's tax note); the migration's CHECK repeats
 * the codes and rates.
 */
export const TAX_CODES = { zero: 0, exempt: 0, vat_14: 14 } as const;
export type TaxCode = keyof typeof TAX_CODES;
export const TAX_CODE_LIST = Object.keys(TAX_CODES) as TaxCode[];

/** A line's tax: its amount at the code's rate, to the piastre (half up). */
export function lineTax(amount: Prisma.Decimal.Value, code: TaxCode): string {
  return new Prisma.Decimal(amount)
    .mul(TAX_CODES[code])
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/** What is held back of a payout at a contract's retention share. */
export function retentionOf(
  gross: Prisma.Decimal.Value,
  pct: Prisma.Decimal.Value | null,
): string {
  if (pct === null) return '0.00';
  return new Prisma.Decimal(gross)
    .mul(pct)
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/** A billed quantity of an order's line (ADR 0094): three decimals, above zero, under a million. */
export const LINE_QUANTITY = /^(?!0+(\.0{1,3})?$)\d{1,6}(\.\d{1,3})?$/;

export const INVOICE_STATUSES = [
  'received',
  'approved',
  'rejected',
  'cancelled',
  'paid',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
/** The invoices that hold their vendor's number and their payment. */
export const LIVE_INVOICE: InvoiceStatus[] = ['received', 'approved', 'paid'];

export const DISBURSEMENT_KINDS = ['advance', 'retention_release'] as const;
export type DisbursementKind = (typeof DISBURSEMENT_KINDS)[number];
export const DISBURSEMENT_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'cancelled',
  'paid',
] as const;
export type DisbursementStatus = (typeof DISBURSEMENT_STATUSES)[number];

export const PAYOUT_METHODS = ['bank_transfer', 'cheque', 'cash'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const GUARANTEE_KINDS = [
  'performance',
  'advance_payment',
  'warranty',
  'other',
] as const;
export type GuaranteeKind = (typeof GUARANTEE_KINDS)[number];
export const GUARANTEE_STATUSES = ['held', 'returned', 'called'] as const;
/** A guarantee's expiry is told this many days ahead, once. */
export const GUARANTEE_NOTICE_DAYS = 30;

export const TRANSFER_STATUSES = [
  'awaiting_board',
  'applied',
  'rejected',
  'withdrawn',
  'lapsed',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const PAYABLE_LIMITS = {
  vendorNumber: 60,
  note: 500,
  lines: 50,
  lineDescription: 200,
  reference: 100,
  transferReason: 500,
  issuer: 120,
  guaranteeReference: 60,
  /** The longest period one entries export or schedule covers. */
  periodDays: 366,
} as const;

/** An item's month in its fiscal year (1 = the first) from a local day. */
export function fiscalMonth(day: string, startMonth: number): number {
  const m = Number(day.slice(5, 7));
  return ((m - startMonth + 12) % 12) + 1;
}

/**
 * A line's months, as stored or, with none, its amount split evenly (the
 * piastres left over go to the last month).
 */
export function monthsOf(
  amount: Prisma.Decimal.Value,
  stored: readonly { month: number; amount: Prisma.Decimal.Value }[],
): Prisma.Decimal[] {
  if (stored.length === 12) {
    const out = Array.from({ length: 12 }, () => new Prisma.Decimal(0));
    for (const m of stored) out[m.month - 1] = new Prisma.Decimal(m.amount);
    return out;
  }
  const total = new Prisma.Decimal(amount);
  const each = total.div(12).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const out = Array.from({ length: 12 }, () => each);
  out[11] = total.sub(each.mul(11));
  return out;
}

/** Four quarters spread on their months: each a third, the rest on the last. */
export function monthsFromQuarters(
  quarters: readonly Prisma.Decimal.Value[],
): Prisma.Decimal[] {
  const out: Prisma.Decimal[] = [];
  for (const q of quarters) {
    const total = new Prisma.Decimal(q);
    const each = total.div(3).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
    out.push(each, each, total.sub(each.mul(2)));
  }
  return out;
}
