import { Prisma } from '@prisma/client';
import { money } from '../money';
import { pour } from './allocation';

const T = '00000000-0000-7000-8000-000000000000';

describe('allocation (ADR 0046, 0048)', () => {
  it('pours the oldest money into the oldest owed invoice, splitting where it must', () => {
    const rows = pour(
      T,
      [
        { id: 'p1', free: money('300') },
        { id: 'p2', free: money('500') },
      ],
      [
        { id: 'i1', owed: money('400') },
        { id: 'i2', owed: money('1000') },
      ],
    );
    expect(
      rows.map((r) => [
        r.paymentId,
        r.invoiceId,
        (r.amount as Prisma.Decimal).toString(),
      ]),
    ).toEqual([
      ['p1', 'i1', '300'],
      ['p2', 'i1', '100'],
      ['p2', 'i2', '400'],
    ]);
  });

  it('marks as credit applied every row but those of the payment taken in this transaction', () => {
    const rows = pour(
      T,
      [
        { id: 'held', free: money('100') },
        { id: 'fresh', free: money('100') },
      ],
      [{ id: 'i1', owed: money('150') }],
      'fresh',
    );
    expect(rows.map((r) => [r.paymentId, r.fromCredit])).toEqual([
      ['held', true],
      ['fresh', false],
    ]);
  });

  it('without a fresh payment (an issue, a reversal, a decision) all of it was credit', () => {
    const rows = pour(
      T,
      [{ id: 'p1', free: money('50') }],
      [{ id: 'i1', owed: money('80') }],
    );
    expect(rows.map((r) => r.fromCredit)).toEqual([true]);
  });
});
