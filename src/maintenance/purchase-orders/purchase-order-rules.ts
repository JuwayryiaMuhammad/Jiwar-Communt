import { Prisma } from '@prisma/client';
import { STOCK_UNITS } from '../stock/stock-rules';

// ============================================================================
// Purchase orders (ADR 0094): the vocabulary and the arithmetic
// ============================================================================

export const ORDER_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'cancelled',
  'closed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_SOURCES = ['direct', 'purchase_request', 'tender'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const REVISION_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const CLOSE_REASONS = ['completed', 'remainder_cancelled'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export const LINE_KINDS = ['stock', 'goods', 'service'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** ADR 0065's stock units and the lot, hour, day and month; the migration's CHECK repeats them. */
export const ORDER_UNITS = [
  ...STOCK_UNITS,
  'lot',
  'hour',
  'day',
  'month',
] as const;
export type OrderUnit = (typeof ORDER_UNITS)[number];

/**
 * A line's VAT code and its rate in percent (ADR 0089, 0093). The same codes
 * as a vendor invoice's lines: finance's `TAX_CODES` (a unit test keeps the
 * two equal; maintenance imports no finance code).
 */
export const LINE_TAX_CODES = { zero: 0, exempt: 0, vat_14: 14 } as const;
export type LineTaxCode = keyof typeof LINE_TAX_CODES;

export const WITHHOLDING_CATEGORY_LIST = [
  'supplies',
  'services',
  'professional',
  'exempt',
] as const;
export type OrderWithholdingCategory =
  (typeof WITHHOLDING_CATEGORY_LIST)[number];

export const ORDER_LIMITS = {
  lines: 50,
  description: 200,
  note: 500,
  decisionNote: 1000,
  deliveryNote: 60,
  photos: 10,
} as const;

/** A quantity: three decimals at most, above zero, under a million. */
export const ORDER_QUANTITY = /^(?!0+(\.0{1,3})?$)\d{1,6}(\.\d{1,3})?$/;
/** Zero or more, three decimals: a receipt's rejected quantity. */
export const ORDER_QUANTITY_OR_ZERO = /^\d{1,6}(\.\d{1,3})?$/;
/** A unit price: above zero, two decimals at most. */
export const ORDER_PRICE = /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/;

export const orderReference = (number: number): string =>
  `PO-${String(number).padStart(6, '0')}`;
export const receiptReference = (number: number): string =>
  `GR-${String(number).padStart(6, '0')}`;

const dec = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/** The unit price times the quantity, to the piastre (half up). */
export function lineNet(
  quantity: Prisma.Decimal.Value,
  unitPrice: Prisma.Decimal.Value,
): Prisma.Decimal {
  return dec(quantity)
    .mul(unitPrice)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** A line's VAT: its net at the code's rate, to the piastre (half up). */
export function lineVat(
  net: Prisma.Decimal.Value,
  code: LineTaxCode,
): Prisma.Decimal {
  return dec(net)
    .mul(LINE_TAX_CODES[code])
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export interface PricedLine {
  quantity: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  taxCode: LineTaxCode;
}

/** An order's net, VAT and gross: the sum of its lines'. */
export function orderTotals(lines: readonly PricedLine[]): {
  subtotal: Prisma.Decimal;
  tax: Prisma.Decimal;
  total: Prisma.Decimal;
} {
  let subtotal = dec(0);
  let tax = dec(0);
  for (const l of lines) {
    const net = lineNet(l.quantity, l.unitPrice);
    subtotal = subtotal.add(net);
    tax = tax.add(lineVat(net, l.taxCode));
  }
  return { subtotal, tax, total: subtotal.add(tax) };
}

/**
 * The most that may be accepted of an ordered quantity: the order and its
 * tolerance (a percentage of the ordered quantity, the compound's setting).
 */
export function receivable(
  ordered: Prisma.Decimal.Value,
  tolerancePct: Prisma.Decimal.Value,
): Prisma.Decimal {
  return dec(ordered)
    .mul(dec(100).add(tolerancePct))
    .div(100)
    .toDecimalPlaces(3, Prisma.Decimal.ROUND_DOWN);
}

/**
 * What an order's line still has to bring or be billed for, gross: the
 * quantity not yet invoiced at the line's price, with its VAT. Zero or more.
 */
export function uninvoicedValue(
  line: PricedLine & { invoicedQuantity: Prisma.Decimal.Value },
  upTo: Prisma.Decimal.Value,
): Prisma.Decimal {
  const left = Prisma.Decimal.max(dec(upTo).sub(line.invoicedQuantity), 0);
  const net = lineNet(left, line.unitPrice);
  return net.add(lineVat(net, line.taxCode));
}

export interface OrderLineFacts {
  id: string;
  quantity: Prisma.Decimal.Value;
  /** Accepted on receipts so far. */
  accepted: Prisma.Decimal.Value;
  /** Billed on approved or paid invoices. */
  invoiced: Prisma.Decimal.Value;
}

/**
 * Fully received and invoiced: every line accepted at its ordered quantity
 * and billed at it. An order with a remainder cancelled is closed by its
 * cancelling, not by this.
 */
export function isComplete(lines: readonly OrderLineFacts[]): boolean {
  return (
    lines.length > 0 &&
    lines.every(
      (l) => dec(l.accepted).gte(l.quantity) && dec(l.invoiced).gte(l.quantity),
    )
  );
}
