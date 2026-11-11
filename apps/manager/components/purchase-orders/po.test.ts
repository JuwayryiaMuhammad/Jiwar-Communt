import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  billLines,
  billReady,
  billRowsFor,
  fromCents,
  fromMilli,
  leftToBill,
  leftToReceive,
  lineFromRequest,
  lineNet,
  lineReady,
  linesBody,
  linesFromOrder,
  linesReady,
  needsStore,
  newLine,
  orderTotals,
  perUnit,
  plainQuantity,
  receiptLines,
  receiptReady,
  scaled,
  settingsReady,
  type FormLine,
  type OrderLineFacts,
  type ReceiveRow,
} from './po.ts';

const line = (patch: Partial<FormLine>): FormLine => ({ ...newLine('goods'), description: 'Paint', quantity: '1', unitPrice: '10', ...patch });

test('a line net is the quantity times the price to the piastre, half up', () => {
  assert.equal(fromCents(lineNet('3', '33.33')!), '99.99');
  assert.equal(fromCents(lineNet('0.5', '0.01')!), '0.01');
  assert.equal(fromCents(lineNet('0.499', '0.01')!), '0.00');
  assert.equal(fromCents(lineNet('2.5', '1.15')!), '2.88');
  assert.equal(fromCents(lineNet('10.250', '19.99')!), '204.90');
  assert.equal(lineNet('', '10'), null);
  assert.equal(lineNet('1.2345', '10'), null);
});

test('an order’s totals add each line’s net and its own VAT, rounded per line', () => {
  const t = orderTotals([
    { quantity: '3', unitPrice: '33.33', taxCode: 'vat_14' },
    { quantity: '1', unitPrice: '0.50', taxCode: 'vat_14' },
    { quantity: '2', unitPrice: '10', taxCode: 'exempt' },
    { quantity: '1', unitPrice: '5', taxCode: 'zero' },
  ]);
  // 99.99 → 14.00 (13.9986), 0.50 → 0.07, the others none.
  assert.deepEqual(t, { subtotal: '125.49', tax: '14.07', total: '139.56' });
  // The VAT is per line, not on the sum: 0.01 at 14% is 0.00 on each of ten lines.
  const tiny = orderTotals(Array.from({ length: 10 }, () => ({ quantity: '1', unitPrice: '0.01', taxCode: 'vat_14' as const })));
  assert.deepEqual(tiny, { subtotal: '0.10', tax: '0.00', total: '0.10' });
  // A line not yet a number counts for nothing.
  assert.deepEqual(orderTotals([{ quantity: '', unitPrice: '5', taxCode: 'vat_14' }]), { subtotal: '0.00', tax: '0.00', total: '0.00' });
});

test('decimal strings are parsed exactly and shown back', () => {
  assert.equal(scaled('12.5', 2), 1250n);
  assert.equal(scaled('12.555', 2), null);
  assert.equal(scaled('abc', 2), null);
  assert.equal(fromMilli(4000n), '4.000');
  assert.equal(fromMilli(5n), '0.005');
  assert.equal(plainQuantity('4.000'), '4');
  assert.equal(plainQuantity('4.500'), '4.5');
  assert.equal(plainQuantity('10'), '10');
  assert.equal(plainQuantity('10.000'), '10');
});

test('a line is ready with its figures and, by its kind, an item or a description', () => {
  assert.equal(lineReady(line({})), true);
  assert.equal(lineReady(line({ description: '  ' })), false);
  assert.equal(lineReady(line({ quantity: '0' })), false);
  assert.equal(lineReady(line({ quantity: '1.2345' })), false);
  assert.equal(lineReady(line({ unitPrice: '0.00' })), false);
  assert.equal(lineReady(line({ kind: 'stock', description: '', stockItemId: '' })), false);
  assert.equal(lineReady(line({ kind: 'stock', description: '', stockItemId: 'item-1' })), true);
  assert.equal(linesReady([]), false);
  assert.equal(linesReady([line({}), line({ unitPrice: '' })]), false);
  assert.equal(linesReady([line({}), line({})]), true);
});

test('the request body carries an item for a stock line and a description and unit for the others', () => {
  const body = linesBody([
    line({ kind: 'stock', stockItemId: 'item-1', description: 'ignored', unit: 'box', quantity: ' 4 ', unitPrice: '12.50', taxCode: 'vat_14', withholding: 'supplies' }),
    line({ id: 'l-2', kind: 'service', description: ' Cleaning ', unit: 'month', quantity: '1', unitPrice: '900' }),
  ]);
  assert.deepEqual(body, [
    { kind: 'stock', stockItemId: 'item-1', quantity: '4', unitPrice: '12.50', taxCode: 'vat_14', withholdingCategory: 'supplies' },
    { id: 'l-2', kind: 'service', description: 'Cleaning', unit: 'month', quantity: '1', unitPrice: '900', taxCode: 'zero' },
  ]);
});

const fact = (patch: Partial<OrderLineFacts>): OrderLineFacts => ({
  id: 'l-1',
  kind: 'goods',
  stockItemId: null,
  description: 'Paint',
  quantity: '10.000',
  unit: 'litre',
  unitPrice: '12.50',
  taxCode: 'vat_14',
  withholdingCategory: 'supplies',
  accepted: '0.000',
  invoiced: '0.000',
  ...patch,
});

test('an amendment starts from the order’s lines, each keeping its id', () => {
  const [a, b] = linesFromOrder([fact({}), fact({ id: 'l-2', kind: 'stock', stockItemId: 'item-9', description: 'Bulb', unit: 'piece', withholdingCategory: null })]);
  assert.equal(a!.id, 'l-1');
  assert.equal(a!.quantity, '10');
  assert.equal(a!.unit, 'litre');
  assert.equal(a!.withholding, 'supplies');
  assert.equal(b!.id, 'l-2');
  assert.equal(b!.stockItemId, 'item-9');
  assert.equal(b!.description, '');
  assert.equal(b!.withholding, '');
  assert.notEqual(a!.key, b!.key);
});

test('a request starts the order with a stock line when it names an item and a quantity, else a service line', () => {
  const stock = lineFromRequest({ title: 'Bulbs', estimatedAmount: '300.00', quantity: '12.000', stockItemId: 'item-1' });
  assert.equal(stock.kind, 'stock');
  assert.equal(stock.quantity, '12');
  assert.equal(stock.unitPrice, '25.00');
  const service = lineFromRequest({ title: 'Repaint the lobby', estimatedAmount: '4500.00', quantity: null, stockItemId: null });
  assert.equal(service.kind, 'service');
  assert.equal(service.description, 'Repaint the lobby');
  assert.equal(service.quantity, '1');
  assert.equal(service.unit, 'lot');
  assert.equal(service.unitPrice, '4500.00');
  assert.equal(perUnit('100.00', '3'), '33.33');
  assert.equal(perUnit('100.00', '0'), '');
});

test('what is left to receive is the ordered quantity less what was accepted, from zero', () => {
  assert.equal(leftToReceive({ quantity: '10.000', accepted: '4.000' }), '6.000');
  assert.equal(leftToReceive({ quantity: '10.000', accepted: '10.000' }), '0.000');
  assert.equal(leftToReceive({ quantity: '10.000', accepted: '10.500' }), '0.000');
});

const row = (patch: Partial<ReceiveRow>): ReceiveRow => ({ orderLineId: 'l-1', accepted: '', rejected: '', rejectReason: '', note: '', ...patch });

test('a receipt needs a quantity, numbers that are numbers and a reason for each rejection', () => {
  assert.equal(receiptReady([row({})]), false);
  assert.equal(receiptReady([row({ accepted: '4' })]), true);
  assert.equal(receiptReady([row({ accepted: '0' })]), false);
  assert.equal(receiptReady([row({ accepted: '4.5555' })]), false);
  assert.equal(receiptReady([row({ rejected: '1' })]), false);
  assert.equal(receiptReady([row({ rejected: '1', rejectReason: 'damaged' })]), true);
  assert.equal(receiptReady([row({ accepted: '3' }), row({ orderLineId: 'l-2', rejected: '1' })]), false);
});

test('the receipt body keeps the rows that carry something, with a reason only where something is rejected', () => {
  const body = receiptLines([
    row({ accepted: '4', note: ' ok ' }),
    row({ orderLineId: 'l-2' }),
    row({ orderLineId: 'l-3', accepted: '2.5', rejected: '1', rejectReason: 'damaged' }),
    row({ orderLineId: 'l-4', accepted: '1', rejectReason: 'damaged' }),
  ]);
  assert.deepEqual(body, [
    { purchaseOrderLineId: 'l-1', accepted: '4.000', note: 'ok' },
    { purchaseOrderLineId: 'l-3', accepted: '2.500', rejected: '1.000', rejectReason: 'damaged' },
    { purchaseOrderLineId: 'l-4', accepted: '1.000' },
  ]);
});

test('a store is asked for only when a stock line has an accepted quantity', () => {
  const kinds = new Map([
    ['l-1', 'stock' as const],
    ['l-2', 'goods' as const],
  ]);
  assert.equal(needsStore([row({ accepted: '2' })], kinds), true);
  assert.equal(needsStore([row({ rejected: '2', rejectReason: 'damaged' })], kinds), false);
  assert.equal(needsStore([row({ orderLineId: 'l-2', accepted: '2' })], kinds), false);
});

test('what is left to bill is what was accepted and not yet billed, at the order’s price', () => {
  assert.equal(leftToBill({ accepted: '10.000', invoiced: '4.000' }), '6.000');
  assert.equal(leftToBill({ accepted: '4.000', invoiced: '6.000' }), '0.000');
  const rows = billRowsFor([fact({ accepted: '10.000', invoiced: '4.000' }), fact({ id: 'l-2', accepted: '0.000' })]);
  assert.deepEqual(rows, [
    { orderLineId: 'l-1', description: 'Paint', quantity: '6', unitPrice: '12.50' },
    { orderLineId: 'l-2', description: 'Paint', quantity: '', unitPrice: '12.50' },
  ]);
});

test('an invoice against an order bills the rows with a quantity and its extra lines by amount', () => {
  const rows = billRowsFor([fact({ accepted: '10.000' }), fact({ id: 'l-2' })]);
  assert.equal(billReady(rows, []), true);
  assert.equal(billReady([rows[1]!], []), false);
  assert.equal(billReady([rows[1]!], [{ description: 'Delivery', amount: '50', taxCode: 'zero' }]), true);
  assert.equal(billReady(rows, [{ description: '', amount: '50', taxCode: 'zero' }]), false);
  assert.equal(billReady([{ ...rows[0]!, unitPrice: '' }], []), false);
  assert.deepEqual(billLines(rows, [{ description: ' Delivery ', amount: '50.00', taxCode: 'vat_14' }]), [
    { description: 'Paint', purchaseOrderLineId: 'l-1', quantity: '10', unitPrice: '12.50' },
    { description: 'Delivery', amount: '50.00', taxCode: 'vat_14' },
  ]);
});

test('the settings are percents to a hundred, an amount from zero and a threshold from zero or none', () => {
  const ok = { pricePct: '2.00', quantityPct: '0', amount: '100.00', poRequiredAbove: '' };
  assert.equal(settingsReady(ok), true);
  assert.equal(settingsReady({ ...ok, poRequiredAbove: '0' }), true);
  assert.equal(settingsReady({ ...ok, poRequiredAbove: '5000.50' }), true);
  assert.equal(settingsReady({ ...ok, pricePct: '100.01' }), false);
  assert.equal(settingsReady({ ...ok, quantityPct: '' }), false);
  assert.equal(settingsReady({ ...ok, amount: '-1' }), false);
  assert.equal(settingsReady({ ...ok, poRequiredAbove: '1.234' }), false);
});
