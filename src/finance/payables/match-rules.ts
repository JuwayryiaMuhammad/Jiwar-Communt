import { Prisma } from '@prisma/client';

// ============================================================================
// The three-way match (ADR 0094): an invoice's lines against the order's and
// what was accepted on receipt, within the compound's tolerances
// ============================================================================

export type MatchIssueKind =
  'quantity_not_received' | 'quantity_over_order' | 'price_over' | 'extra_line';

export const MATCH_ISSUE_KINDS: readonly MatchIssueKind[] = [
  'quantity_not_received',
  'quantity_over_order',
  'price_over',
  'extra_line',
];

export interface MatchTolerance {
  /** A unit price may exceed the order's by this percentage. */
  pricePct: Prisma.Decimal.Value;
  /** A quantity may exceed the ordered, and the received, by this percentage. */
  quantityPct: Prisma.Decimal.Value;
  /** A line may vary by this much money (an extra line may be this much). */
  amount: Prisma.Decimal.Value;
}

/** An order's line, with what has been accepted and billed of it. */
export interface MatchOrderLine {
  id: string;
  position: number;
  description: string;
  ordered: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  /** Accepted on receipts. */
  accepted: Prisma.Decimal.Value;
  /** Billed on the other invoices that count before this one. */
  otherInvoiced: Prisma.Decimal.Value;
}

export interface MatchInvoiceLine {
  position: number;
  orderLineId: string | null;
  quantity: Prisma.Decimal.Value | null;
  unitPrice: Prisma.Decimal.Value | null;
  amount: Prisma.Decimal.Value;
}

export interface MatchIssue {
  kind: MatchIssueKind;
  /** The invoice line's position. */
  position: number;
  orderLineId: string | null;
  /** The quantity over (quantity issues); null otherwise. */
  quantity: string | null;
  /** The money over: the line's price variance, or an extra line's amount. */
  amount: string;
}

export interface MatchLineResult {
  position: number;
  orderLineId: string | null;
  /** Signed: what the unit price exceeds (positive) or falls short of the order's. */
  priceDifference: string | null;
  /** Signed: the unit price difference times the invoiced quantity. */
  priceVariance: string;
  issues: MatchIssueKind[];
}

export interface MatchResult {
  status: 'matched' | 'blocked';
  issues: MatchIssue[];
  lines: MatchLineResult[];
  /** The sum of the lines' price variances, signed, within tolerance or not. */
  priceVariance: string;
}

const dec = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = dec(0);

/** An amount with the percentage allowed on top of it. */
function withTolerance(
  base: Prisma.Decimal.Value,
  pct: Prisma.Decimal.Value,
): Prisma.Decimal {
  return dec(base).mul(dec(100).add(pct)).div(100);
}

/**
 * Matches an invoice's lines. A line that names an order line is held to
 * that line's ordered quantity (over it: `quantity_over_order`), to what was
 * accepted of it (over it: `quantity_not_received`) — both counting what the
 * other invoices billed and the percentage of quantity tolerance — and to
 * its price: a unit price above the order's by more than the price
 * percentage, or a line varying by more than the amount, is `price_over`; a
 * lower price is the compound's gain and never an issue. A line that names
 * no order line is `extra_line` above the amount tolerance. No issue: the
 * invoice is `matched` and goes on to approval as any; an issue blocks its
 * approval until it is resolved or overridden.
 */
export function evaluateMatch(
  tolerance: MatchTolerance,
  orderLines: readonly MatchOrderLine[],
  invoiceLines: readonly MatchInvoiceLine[],
): MatchResult {
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  const issues: MatchIssue[] = [];
  const lines: MatchLineResult[] = [];
  let total = ZERO;
  for (const l of invoiceLines) {
    const order = l.orderLineId ? byId.get(l.orderLineId) : undefined;
    const found: MatchIssueKind[] = [];
    if (!order || l.quantity === null || l.unitPrice === null) {
      if (dec(l.amount).gt(tolerance.amount)) {
        found.push('extra_line');
        issues.push({
          kind: 'extra_line',
          position: l.position,
          orderLineId: null,
          quantity: null,
          amount: dec(l.amount).toFixed(2),
        });
      }
      lines.push({
        position: l.position,
        orderLineId: null,
        priceDifference: null,
        priceVariance: '0.00',
        issues: found,
      });
      continue;
    }
    const quantity = dec(l.quantity);
    const cumulative = dec(order.otherInvoiced).add(quantity);
    const orderMax = withTolerance(order.ordered, tolerance.quantityPct);
    const receivedMax = withTolerance(order.accepted, tolerance.quantityPct);
    if (cumulative.gt(orderMax)) {
      found.push('quantity_over_order');
      issues.push({
        kind: 'quantity_over_order',
        position: l.position,
        orderLineId: order.id,
        quantity: cumulative
          .sub(orderMax)
          .toDecimalPlaces(3, Prisma.Decimal.ROUND_UP)
          .toFixed(3),
        amount: cumulative
          .sub(orderMax)
          .mul(order.unitPrice)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
          .toFixed(2),
      });
    } else if (cumulative.gt(receivedMax)) {
      found.push('quantity_not_received');
      issues.push({
        kind: 'quantity_not_received',
        position: l.position,
        orderLineId: order.id,
        quantity: cumulative
          .sub(receivedMax)
          .toDecimalPlaces(3, Prisma.Decimal.ROUND_UP)
          .toFixed(3),
        amount: cumulative
          .sub(receivedMax)
          .mul(order.unitPrice)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
          .toFixed(2),
      });
    }
    const difference = dec(l.unitPrice).sub(order.unitPrice);
    const variance = difference
      .mul(quantity)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    total = total.add(variance);
    if (difference.gt(0)) {
      const pct = dec(order.unitPrice).gt(0)
        ? difference.div(order.unitPrice).mul(100)
        : dec(Infinity);
      if (pct.gt(tolerance.pricePct) || variance.gt(tolerance.amount)) {
        found.push('price_over');
        issues.push({
          kind: 'price_over',
          position: l.position,
          orderLineId: order.id,
          quantity: null,
          amount: variance.toFixed(2),
        });
      }
    }
    lines.push({
      position: l.position,
      orderLineId: order.id,
      priceDifference: difference.toFixed(2),
      priceVariance: variance.toFixed(2),
      issues: found,
    });
  }
  return {
    status: issues.length ? 'blocked' : 'matched',
    issues,
    lines,
    priceVariance: total.toFixed(2),
  };
}

/**
 * Whether a purchase order is required for an invoice of this total (ADR
 * 0094): never when the compound set no amount; otherwise above it.
 */
export function orderRequired(
  above: Prisma.Decimal.Value | null,
  total: Prisma.Decimal.Value,
): boolean {
  return above !== null && dec(total).gt(above);
}
