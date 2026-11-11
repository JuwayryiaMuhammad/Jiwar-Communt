import { STOCK_UNITS } from '../stock/stock-rules';
import {
  isComplete,
  lineNet,
  lineVat,
  LINE_TAX_CODES,
  ORDER_PRICE,
  ORDER_QUANTITY,
  ORDER_UNITS,
  orderReference,
  orderTotals,
  receiptReference,
  receivable,
  uninvoicedValue,
} from './purchase-order-rules';

describe('purchase orders (ADR 0094)', () => {
  it('uses the same VAT codes as a vendor invoice and the stock units besides its own', () => {
    // The same as finance's TAX_CODES (checked there): maintenance imports no finance code.
    expect(LINE_TAX_CODES).toEqual({ zero: 0, exempt: 0, vat_14: 14 });
    for (const u of STOCK_UNITS) expect(ORDER_UNITS).toContain(u);
    expect(ORDER_UNITS).toEqual(
      expect.arrayContaining(['lot', 'hour', 'day', 'month']),
    );
  });

  it('numbers an order PO- and a receipt GR-', () => {
    expect(orderReference(12)).toBe('PO-000012');
    expect(receiptReference(3)).toBe('GR-000003');
  });

  it('prices a line to the piastre, half up, and its VAT on the net', () => {
    expect(lineNet('3', '33.33').toFixed(2)).toBe('99.99');
    expect(lineNet('2.5', '0.05').toFixed(2)).toBe('0.13');
    expect(lineVat('99.99', 'vat_14').toFixed(2)).toBe('14.00');
    expect(lineVat('99.99', 'exempt').toFixed(2)).toBe('0.00');
  });

  it('adds up net, VAT and gross per line, the way the database’s CHECK does', () => {
    const t = orderTotals([
      { quantity: '10', unitPrice: '12.50', taxCode: 'vat_14' },
      { quantity: '1', unitPrice: '300.00', taxCode: 'zero' },
      { quantity: '3', unitPrice: '0.33', taxCode: 'vat_14' },
    ]);
    // 125.00 + 300.00 + 0.99; VAT 17.50 + 0 + 0.14
    expect(t.subtotal.toFixed(2)).toBe('425.99');
    expect(t.tax.toFixed(2)).toBe('17.64');
    expect(t.total.toFixed(2)).toBe('443.63');
  });

  it('takes a quantity over the order only within the tolerance', () => {
    expect(receivable('10', '0').toFixed(3)).toBe('10.000');
    expect(receivable('10', '5').toFixed(3)).toBe('10.500');
    expect(receivable('3', '10').toFixed(3)).toBe('3.300');
  });

  it('holds back the value of what arrived and is not invoiced, with its VAT', () => {
    const line = {
      quantity: '10',
      unitPrice: '20.00',
      taxCode: 'vat_14' as const,
    };
    expect(
      uninvoicedValue({ ...line, invoicedQuantity: '4' }, '7').toFixed(2),
    ).toBe('68.40');
    expect(
      uninvoicedValue({ ...line, invoicedQuantity: '7' }, '7').toFixed(2),
    ).toBe('0.00');
    // Billed more than accepted: nothing is held, never a negative.
    expect(
      uninvoicedValue({ ...line, invoicedQuantity: '9' }, '7').toFixed(2),
    ).toBe('0.00');
  });

  it('is complete once every line is accepted and billed at its ordered quantity', () => {
    const line = (accepted: string, invoiced: string) => ({
      id: 'l',
      quantity: '10',
      accepted,
      invoiced,
    });
    expect(isComplete([])).toBe(false);
    expect(isComplete([line('10', '10')])).toBe(true);
    expect(isComplete([line('10.2', '10.2')])).toBe(true);
    expect(isComplete([line('10', '9')])).toBe(false);
    expect(isComplete([line('9', '10')])).toBe(false);
    expect(isComplete([line('10', '10'), line('4', '4')])).toBe(false);
  });

  it('reads quantities and prices the way the API takes them', () => {
    for (const ok of ['1', '0.001', '999999.999', '12.5'])
      expect(ORDER_QUANTITY.test(ok)).toBe(true);
    for (const bad of ['0', '0.000', '-1', '1.0001', '1000000', 'x'])
      expect(ORDER_QUANTITY.test(bad)).toBe(false);
    for (const ok of ['0.01', '12', '999999999.99'])
      expect(ORDER_PRICE.test(ok)).toBe(true);
    for (const bad of ['0', '0.00', '1.001', '1000000000', ''])
      expect(ORDER_PRICE.test(bad)).toBe(false);
  });
});
