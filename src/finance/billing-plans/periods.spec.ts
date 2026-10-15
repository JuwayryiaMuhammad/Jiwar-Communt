import {
  addMonths,
  periodHolding,
  periodLabel,
  periodsToBill,
} from './periods';

const monthly = {
  frequency: 'monthly' as const,
  startsOn: '2026-11-01',
  issueDaysBefore: 5,
};
const quarterly = {
  frequency: 'quarterly' as const,
  startsOn: '2026-01-01',
  issueDaysBefore: 0,
};

describe('billing periods (ADR 0046)', () => {
  it('adds months across years', () => {
    expect(addMonths('2026-11-01', 1)).toBe('2026-12-01');
    expect(addMonths('2026-11-01', 2)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', 12)).toBe('2027-01-01');
    expect(addMonths('2026-03-01', -3)).toBe('2025-12-01');
  });

  it('the period holding a day; none before the plan starts', () => {
    expect(periodHolding(monthly, '2026-10-31')).toBeNull();
    expect(periodHolding(monthly, '2026-11-01')).toEqual({
      start: '2026-11-01',
      end: '2026-12-01',
    });
    expect(periodHolding(monthly, '2027-02-28')).toEqual({
      start: '2027-02-01',
      end: '2027-03-01',
    });
    expect(periodHolding(quarterly, '2026-05-15')).toEqual({
      start: '2026-04-01',
      end: '2026-07-01',
    });
    expect(
      periodHolding({ ...quarterly, frequency: 'annual' }, '2027-12-31'),
    ).toEqual({
      start: '2027-01-01',
      end: '2028-01-01',
    });
  });

  it('bills the current period, and the next within its lead days', () => {
    expect(periodsToBill(monthly, '2026-10-26')).toEqual([]);
    expect(periodsToBill(monthly, '2026-10-27')).toEqual([
      { start: '2026-11-01', end: '2026-12-01' },
    ]);
    expect(periodsToBill(monthly, '2026-11-15')).toEqual([
      { start: '2026-11-01', end: '2026-12-01' },
    ]);
    expect(periodsToBill(monthly, '2026-11-26')).toEqual([
      { start: '2026-11-01', end: '2026-12-01' },
      { start: '2026-12-01', end: '2027-01-01' },
    ]);
    // No lead days: the next period on its first day only.
    expect(periodsToBill(quarterly, '2026-03-31')).toEqual([
      { start: '2026-01-01', end: '2026-04-01' },
    ]);
    expect(periodsToBill(quarterly, '2026-04-01')).toEqual([
      { start: '2026-04-01', end: '2026-07-01' },
    ]);
  });

  it('names a period by its first and last day', () => {
    expect(periodLabel({ start: '2026-11-01', end: '2026-12-01' })).toBe(
      '2026-11-01 – 2026-11-30',
    );
    expect(periodLabel({ start: '2027-02-01', end: '2027-03-01' })).toBe(
      '2027-02-01 – 2027-02-28',
    );
  });
});
