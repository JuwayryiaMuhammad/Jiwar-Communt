/**
 * Purchase orders' arithmetic and request bodies on the dashboard (ADR 0094).
 * Plain TypeScript, no imports: quantities have three decimals, prices two,
 * and they are decimal strings. The sums are in whole thousandths and
 * piastres (BigInt), rounded half up exactly as the API does, so the total
 * on the screen is the total the API computes.
 */

export const LINE_KINDS = ['stock', 'goods', 'service'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const UNITS = ['piece', 'metre', 'litre', 'kilogram', 'box', 'set', 'pair', 'roll', 'lot', 'hour', 'day', 'month'] as const;
export type Unit = (typeof UNITS)[number];

export const TAX_CODES = ['zero', 'exempt', 'vat_14'] as const;
export type TaxCode = (typeof TAX_CODES)[number];

export const WITHHOLDING = ['supplies', 'services', 'professional', 'exempt'] as const;
export type Withholding = (typeof WITHHOLDING)[number];

/** The VAT rate of a code, in percent. */
export const VAT_RATE: Record<TaxCode, bigint> = { zero: 0n, exempt: 0n, vat_14: 14n };

/** An order has at most this many lines, a description this many characters. */
export const MAX_LINES = 50;
export const MAX_DESCRIPTION = 200;
export const MAX_PHOTOS = 10;

/** A quantity: three decimals at most, above zero, under a million. */
export const QUANTITY = /^(?!0+(\.0{1,3})?$)\d{1,6}(\.\d{1,3})?$/;
/** Zero or more, three decimals. */
export const QUANTITY_OR_ZERO = /^\d{1,6}(\.\d{1,3})?$/;
/** A unit price: above zero, two decimals at most. */
export const PRICE = /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/;
/** An amount: above zero, two decimals at most. */
export const AMOUNT = PRICE;
/** A tolerance in percent: 0 to 100, two decimals at most. */
export const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

/** A decimal string as whole units of 10^-decimals; null when it is not one or has more decimals. */
export function scaled(value: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return null;
  return BigInt(m[1]! + fraction.padEnd(decimals, '0'));
}

function show(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  return `${negative ? '-' : ''}${whole}${decimals ? `.${digits.slice(digits.length - decimals)}` : ''}`;
}

/** Piastres as `1200.00`. */
export const fromCents = (cents: bigint): string => show(cents, 2);
/** Thousandths as `4.000`. */
export const fromMilli = (milli: bigint): string => show(milli, 3);

/** `4.000` → `4`, `4.500` → `4.5`: a quantity as people write it. */
export function plainQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** Rounds a non-negative `n / d` half up. */
const divRound = (n: bigint, d: bigint): bigint => (n * 2n + d) / (2n * d);

/** A line's net in piastres: the quantity times the unit price, half up. Null while either is not a number. */
export function lineNet(quantity: string, unitPrice: string): bigint | null {
  const q = scaled(quantity, 3);
  const p = scaled(unitPrice, 2);
  if (q === null || p === null) return null;
  return divRound(q * p, 1000n);
}

/** A line's VAT in piastres: its net at the code's rate, half up. */
export const lineVat = (net: bigint, code: TaxCode): bigint => divRound(net * VAT_RATE[code], 100n);

export interface Totals {
  subtotal: string;
  tax: string;
  total: string;
}

/** An order's net, VAT and gross: the sums of its lines'; a line not yet a number counts for nothing. */
export function orderTotals(lines: readonly { quantity: string; unitPrice: string; taxCode: TaxCode }[]): Totals {
  let subtotal = 0n;
  let tax = 0n;
  for (const l of lines) {
    const net = lineNet(l.quantity, l.unitPrice);
    if (net === null) continue;
    subtotal += net;
    tax += lineVat(net, l.taxCode);
  }
  return { subtotal: fromCents(subtotal), tax: fromCents(tax), total: fromCents(subtotal + tax) };
}

/** One line of the lines editor. */
export interface FormLine {
  /** For React only. */
  key: string;
  /** An existing line of the order (an amendment); absent: a new one. */
  id?: string;
  kind: LineKind;
  stockItemId: string;
  description: string;
  quantity: string;
  unit: Unit;
  unitPrice: string;
  taxCode: TaxCode;
  withholding: '' | Withholding;
}

let counter = 0;
export function newLine(kind: LineKind = 'goods'): FormLine {
  counter += 1;
  return {
    key: `line-${counter}`,
    kind,
    stockItemId: '',
    description: '',
    quantity: '',
    unit: 'piece',
    unitPrice: '',
    taxCode: 'zero',
    withholding: '',
  };
}

/** Whether a line can be sent: a stock line names its item; the others a description and a unit. */
export function lineReady(l: FormLine): boolean {
  if (!QUANTITY.test(l.quantity.trim()) || !PRICE.test(l.unitPrice.trim())) return false;
  if (l.kind === 'stock') return l.stockItemId !== '';
  const d = l.description.trim();
  return d !== '' && d.length <= MAX_DESCRIPTION;
}

export function linesReady(lines: readonly FormLine[]): boolean {
  return lines.length > 0 && lines.length <= MAX_LINES && lines.every(lineReady);
}

/** The lines as the API takes them (`PurchaseOrderLineDto`). */
export function linesBody(lines: readonly FormLine[]) {
  return lines.map((l) => ({
    ...(l.id ? { id: l.id } : {}),
    kind: l.kind,
    ...(l.kind === 'stock' ? { stockItemId: l.stockItemId } : { description: l.description.trim(), unit: l.unit }),
    quantity: l.quantity.trim(),
    unitPrice: l.unitPrice.trim(),
    taxCode: l.taxCode,
    ...(l.withholding ? { withholdingCategory: l.withholding } : {}),
  }));
}

/** An order's line as the API shows it (`PurchaseOrderLineView`). */
export interface OrderLineFacts {
  id: string;
  kind: LineKind;
  stockItemId: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxCode: TaxCode;
  withholdingCategory: string | null;
  accepted: string;
  invoiced: string;
}

const isUnit = (v: string): v is Unit => (UNITS as readonly string[]).includes(v);
const isWithholding = (v: string | null): v is Withholding => v !== null && (WITHHOLDING as readonly string[]).includes(v);

/** The editor's lines from an order's, for an amendment: each keeps its id. */
export function linesFromOrder(lines: readonly OrderLineFacts[]): FormLine[] {
  return lines.map((l) => ({
    ...newLine(l.kind),
    id: l.id,
    stockItemId: l.stockItemId ?? '',
    description: l.kind === 'stock' ? '' : l.description,
    quantity: plainQuantity(l.quantity),
    unit: isUnit(l.unit) ? l.unit : 'piece',
    unitPrice: l.unitPrice,
    taxCode: l.taxCode,
    withholding: isWithholding(l.withholdingCategory) ? l.withholdingCategory : '',
  }));
}

/** The estimate over the quantity, to the piastre: what a request's stock line starts at. Empty when it is not a number. */
export function perUnit(estimate: string, quantity: string): string {
  const e = scaled(estimate, 2);
  const q = scaled(quantity, 3);
  if (e === null || q === null || q === 0n) return '';
  return fromCents(divRound(e * 1000n, q));
}

/** What an approved purchase request starts the order with: one line. */
export function lineFromRequest(r: { title: string; estimatedAmount: string; quantity: string | null; stockItemId: string | null }): FormLine {
  if (r.stockItemId && r.quantity) {
    return { ...newLine('stock'), stockItemId: r.stockItemId, quantity: plainQuantity(r.quantity), unitPrice: perUnit(r.estimatedAmount, r.quantity) };
  }
  return {
    ...newLine('service'),
    description: r.title.slice(0, MAX_DESCRIPTION),
    quantity: '1',
    unit: 'lot',
    unitPrice: scaled(r.estimatedAmount, 2) !== null ? r.estimatedAmount : '',
  };
}

// ---- Receiving -----------------------------------------------------------

/** What a receipt line is typed as. */
export interface ReceiveRow {
  orderLineId: string;
  accepted: string;
  rejected: string;
  rejectReason: string;
  note: string;
}

/** What is still to come on a line: the ordered quantity less what was accepted, from zero. */
export function leftToReceive(line: { quantity: string; accepted: string }): string {
  const ordered = scaled(line.quantity, 3) ?? 0n;
  const accepted = scaled(line.accepted, 3) ?? 0n;
  return fromMilli(ordered > accepted ? ordered - accepted : 0n);
}

const milli = (v: string): bigint => (v.trim() === '' ? 0n : (scaled(v, 3) ?? 0n));
const quantityOk = (v: string) => v.trim() === '' || QUANTITY_OR_ZERO.test(v.trim());

/** A row that carries something: a quantity accepted or rejected. */
export const receiveRowUsed = (r: ReceiveRow): boolean => milli(r.accepted) > 0n || milli(r.rejected) > 0n;

/** Whether the receipt can be sent: numbers that are numbers, at least one quantity, a reason for each rejection. */
export function receiptReady(rows: readonly ReceiveRow[]): boolean {
  if (!rows.every((r) => quantityOk(r.accepted) && quantityOk(r.rejected))) return false;
  const used = rows.filter(receiveRowUsed);
  return used.length > 0 && used.every((r) => milli(r.rejected) === 0n || r.rejectReason !== '');
}

/** The store is asked for when a stock line has an accepted quantity. */
export function needsStore(rows: readonly ReceiveRow[], kinds: ReadonlyMap<string, LineKind>): boolean {
  return rows.some((r) => kinds.get(r.orderLineId) === 'stock' && milli(r.accepted) > 0n);
}

/** The lines of a receipt as the API takes them: the rows that carry something. */
export function receiptLines(rows: readonly ReceiveRow[]) {
  return rows.filter(receiveRowUsed).map((r) => ({
    purchaseOrderLineId: r.orderLineId,
    accepted: fromMilli(milli(r.accepted)),
    ...(milli(r.rejected) > 0n ? { rejected: fromMilli(milli(r.rejected)), rejectReason: r.rejectReason } : {}),
    ...(r.note.trim() ? { note: r.note.trim() } : {}),
  }));
}

// ---- Billing -------------------------------------------------------------

/** What was accepted and is not yet billed on approved or paid invoices, from zero. */
export function leftToBill(line: { accepted: string; invoiced: string }): string {
  const accepted = scaled(line.accepted, 3) ?? 0n;
  const invoiced = scaled(line.invoiced, 3) ?? 0n;
  return fromMilli(accepted > invoiced ? accepted - invoiced : 0n);
}

/** An invoice line against an order's line, as typed. */
export interface BillRow {
  orderLineId: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

/** A line the order does not have, as typed. */
export interface ExtraRow {
  description: string;
  amount: string;
  taxCode: TaxCode;
}

/** The rows to bill start at what is accepted and not yet billed, at the order's price; a line with nothing left starts empty. */
export function billRowsFor(lines: readonly (OrderLineFacts & { position?: number })[]): BillRow[] {
  return lines.map((l) => {
    const left = leftToBill(l);
    return {
      orderLineId: l.id,
      description: l.description,
      quantity: milli(left) > 0n ? plainQuantity(left) : '',
      unitPrice: l.unitPrice,
    };
  });
}

const billed = (r: BillRow): boolean => r.quantity.trim() !== '';

/** Whether the invoice's order lines and extra lines can be sent: something billed, every figure a number. */
export function billReady(rows: readonly BillRow[], extras: readonly ExtraRow[]): boolean {
  const used = rows.filter(billed);
  if (!used.every((r) => QUANTITY.test(r.quantity.trim()) && PRICE.test(r.unitPrice.trim()))) return false;
  if (!extras.every((x) => x.description.trim() !== '' && AMOUNT.test(x.amount.trim()))) return false;
  return used.length + extras.length > 0;
}

/** The invoice's lines as the API takes them (`VendorInvoiceLineDto`). */
export function billLines(rows: readonly BillRow[], extras: readonly ExtraRow[]) {
  return [
    ...rows.filter(billed).map((r) => ({
      description: r.description.trim() || r.orderLineId,
      purchaseOrderLineId: r.orderLineId,
      quantity: r.quantity.trim(),
      unitPrice: r.unitPrice.trim(),
    })),
    ...extras.map((x) => ({ description: x.description.trim(), amount: x.amount.trim(), taxCode: x.taxCode })),
  ];
}

// ---- Settings ------------------------------------------------------------

/** The tolerances and the threshold as typed. */
export interface SettingsForm {
  pricePct: string;
  quantityPct: string;
  amount: string;
  /** Empty: an order is never required. */
  poRequiredAbove: string;
}

/** An amount from zero, two decimals at most. */
export const AMOUNT_OR_ZERO = /^\d{1,9}(\.\d{1,2})?$/;

/** Whether the settings can be saved: percents from 0 to 100, an amount from zero, a threshold from zero or empty (never). */
export function settingsReady(s: SettingsForm): boolean {
  const pct = (v: string) => PERCENT.test(v.trim()) && Number(v) <= 100;
  return (
    pct(s.pricePct) &&
    pct(s.quantityPct) &&
    AMOUNT_OR_ZERO.test(s.amount.trim()) &&
    (s.poRequiredAbove.trim() === '' || AMOUNT_OR_ZERO.test(s.poRequiredAbove.trim()))
  );
}
