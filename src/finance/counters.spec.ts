import { COUNTER_ORDER, formatNumber, inOrder } from './counters';

describe('finance counters (ADR 0046, 0048, 0055)', () => {
  it('numbers read as their prefix and six digits at least', () => {
    expect(formatNumber('instalment_plan', 7)).toBe('IP-000007');
    expect(formatNumber('refund', 1234567)).toBe('RF-1234567');
  });

  it('a transaction takes counters in the one order, repeating a kind as it likes', () => {
    const tx = {};
    for (const kind of COUNTER_ORDER) {
      inOrder(tx, kind);
      inOrder(tx, kind);
    }
  });

  it('an earlier kind after a later one is refused: two such transactions could deadlock', () => {
    const tx = {};
    inOrder(tx, 'invoice');
    expect(() => inOrder(tx, 'credit_note')).toThrow(
      /credit_note taken after invoice/,
    );
    // Another transaction is not concerned.
    inOrder({}, 'credit_note');
  });

  it('the order puts a plan before its credit note, and both before the invoices they lead to', () => {
    expect(COUNTER_ORDER).toEqual([
      'instalment_plan',
      'credit_note',
      'invoice',
      'refund',
      'receipt',
      // An expense takes no other counter (ADR 0055).
      'expense',
      'clearance',
      'deposit',
    ]);
    expect(formatNumber('expense', 12)).toBe('EX-000012');
  });
});
