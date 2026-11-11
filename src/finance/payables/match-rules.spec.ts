import {
  evaluateMatch,
  orderRequired,
  type MatchOrderLine,
  type MatchTolerance,
} from './match-rules';

// The defaults of ADR 0094: 2 % on the price, 0 % on the quantity, 100 EGP.
const TOLERANCE: MatchTolerance = {
  pricePct: '2.00',
  quantityPct: '0.00',
  amount: '100.00',
};

const line = (over: Partial<MatchOrderLine> = {}): MatchOrderLine => ({
  id: 'L1',
  position: 1,
  description: 'Pump',
  ordered: '10',
  unitPrice: '100.00',
  accepted: '10',
  otherInvoiced: '0',
  ...over,
});

const bill = (
  quantity: string,
  unitPrice: string,
  id: string | null = 'L1',
) => ({
  position: 1,
  orderLineId: id,
  quantity,
  unitPrice,
  amount: (Number(quantity) * Number(unitPrice)).toFixed(2),
});

describe('the three-way match (ADR 0094)', () => {
  it('matches an invoice of what was ordered, received and priced', () => {
    const m = evaluateMatch(TOLERANCE, [line()], [bill('10', '100.00')]);
    expect(m.status).toBe('matched');
    expect(m.issues).toEqual([]);
    expect(m.priceVariance).toBe('0.00');
  });

  it('lets a price within the percentage and the amount through, and reports the variance', () => {
    // +1 % on 10 units: 10.00 over.
    const m = evaluateMatch(TOLERANCE, [line()], [bill('10', '101.00')]);
    expect(m.status).toBe('matched');
    expect(m.priceVariance).toBe('10.00');
    expect(m.lines[0].priceDifference).toBe('1.00');
  });

  it('blocks a price above the percentage', () => {
    const m = evaluateMatch(TOLERANCE, [line()], [bill('10', '103.00')]);
    expect(m.status).toBe('blocked');
    expect(m.issues).toEqual([
      expect.objectContaining({ kind: 'price_over', amount: '30.00' }),
    ]);
  });

  it('blocks a price within the percentage whose line varies by more than the amount', () => {
    // +1.5 % of 100 000 a unit, once: 1 500 over, more than 100.
    const m = evaluateMatch(
      TOLERANCE,
      [line({ ordered: '1', accepted: '1', unitPrice: '100000.00' })],
      [bill('1', '101500.00')],
    );
    expect(m.status).toBe('blocked');
    expect(m.issues[0]).toMatchObject({
      kind: 'price_over',
      amount: '1500.00',
    });
  });

  it('never blocks a lower price', () => {
    const m = evaluateMatch(TOLERANCE, [line()], [bill('10', '80.00')]);
    expect(m.status).toBe('matched');
    expect(m.priceVariance).toBe('-200.00');
  });

  it('blocks a quantity beyond what was accepted, and beyond the order, with no tolerance', () => {
    const received = evaluateMatch(
      TOLERANCE,
      [line({ accepted: '6' })],
      [bill('10', '100.00')],
    );
    expect(received.issues).toEqual([
      expect.objectContaining({
        kind: 'quantity_not_received',
        quantity: '4.000',
      }),
    ]);
    const ordered = evaluateMatch(TOLERANCE, [line()], [bill('11', '100.00')]);
    expect(ordered.issues).toEqual([
      expect.objectContaining({
        kind: 'quantity_over_order',
        quantity: '1.000',
      }),
    ]);
  });

  it('counts what the other invoices billed before it', () => {
    const m = evaluateMatch(
      TOLERANCE,
      [line({ otherInvoiced: '6' })],
      [bill('5', '100.00')],
    );
    expect(m.issues).toEqual([
      expect.objectContaining({
        kind: 'quantity_over_order',
        quantity: '1.000',
      }),
    ]);
    // A partial invoice for what arrived is fine.
    expect(
      evaluateMatch(TOLERANCE, [line({ accepted: '4' })], [bill('4', '100.00')])
        .status,
    ).toBe('matched');
  });

  it('takes the quantity tolerance on the ordered and on the accepted', () => {
    const tolerant = { ...TOLERANCE, quantityPct: '5' };
    expect(
      evaluateMatch(
        tolerant,
        [line({ accepted: '10.5' })],
        [bill('10.5', '100.00')],
      ).status,
    ).toBe('matched');
    expect(
      evaluateMatch(
        tolerant,
        [line({ accepted: '10.5' })],
        [bill('10.6', '100.00')],
      ).status,
    ).toBe('blocked');
  });

  it('lets a small extra line through (freight) and blocks a large one', () => {
    const extra = (amount: string) => ({
      position: 2,
      orderLineId: null,
      quantity: null,
      unitPrice: null,
      amount,
    });
    expect(
      evaluateMatch(TOLERANCE, [line()], [bill('10', '100.00'), extra('90.00')])
        .status,
    ).toBe('matched');
    const big = evaluateMatch(
      TOLERANCE,
      [line()],
      [bill('10', '100.00'), extra('150.00')],
    );
    expect(big.status).toBe('blocked');
    expect(big.issues).toEqual([
      expect.objectContaining({
        kind: 'extra_line',
        position: 2,
        amount: '150.00',
      }),
    ]);
  });

  it('requires an order only above the compound’s amount, never when none is set', () => {
    expect(orderRequired(null, '1000000')).toBe(false);
    expect(orderRequired('5000.00', '5000.00')).toBe(false);
    expect(orderRequired('5000.00', '5000.01')).toBe(true);
    // 0: every invoice with no contract.
    expect(orderRequired('0', '0.01')).toBe(true);
  });
});
