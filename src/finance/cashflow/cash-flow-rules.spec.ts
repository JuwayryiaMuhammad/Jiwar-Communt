import { Prisma } from '@prisma/client';
import {
  closings,
  collectionRate,
  dailySpending,
  expectedOf,
  liquidityDays,
  periodIndex,
  periodsFrom,
  planPeriods,
  splitRetention,
  windowBefore,
} from './cash-flow-rules';

const d = (v: Prisma.Decimal) => v.toFixed(2);

describe('cash flow rules (ADR 0091)', () => {
  it('weeks run Saturday to Friday, the first from today; months are calendar months', () => {
    // 2026-11-08 is a Sunday.
    expect(periodsFrom('week', 3, '2026-11-08')).toEqual([
      { from: '2026-11-08', to: '2026-11-13' },
      { from: '2026-11-14', to: '2026-11-20' },
      { from: '2026-11-21', to: '2026-11-27' },
    ]);
    // A Friday is a week of one day; a Saturday a whole week.
    expect(periodsFrom('week', 1, '2026-11-13')).toEqual([
      { from: '2026-11-13', to: '2026-11-13' },
    ]);
    expect(periodsFrom('week', 1, '2026-11-14')).toEqual([
      { from: '2026-11-14', to: '2026-11-20' },
    ]);
    expect(periodsFrom('month', 3, '2026-12-30')).toEqual([
      { from: '2026-12-30', to: '2026-12-31' },
      { from: '2027-01-01', to: '2027-01-31' },
      { from: '2027-02-01', to: '2027-02-28' },
    ]);
  });

  it('an overdue day falls in the first period, one past the horizon in none', () => {
    const p = periodsFrom('week', 2, '2026-11-08');
    expect(periodIndex(p, '2026-10-01')).toBe(0);
    expect(periodIndex(p, '2026-11-08')).toBe(0);
    expect(periodIndex(p, '2026-11-14')).toBe(1);
    expect(periodIndex(p, '2026-11-20')).toBe(1);
    expect(periodIndex(p, '2026-11-21')).toBe(-1);
  });

  it('the window is the 90 days before today', () => {
    expect(windowBefore('2026-11-08')).toEqual({
      from: '2026-08-10',
      to: '2026-11-07',
    });
  });

  it('the collection rate is collected over due to three places, at most 1; no history is null', () => {
    expect(collectionRate('1000', '874.4')).toBe(0.874);
    expect(collectionRate('1000', '1200')).toBe(1);
    expect(collectionRate('1000', '0')).toBe(0);
    expect(collectionRate('0', '0')).toBeNull();
  });

  it('dues are expected at the rate, to the piastre; with no rate nothing is expected', () => {
    expect(d(expectedOf('1000.05', 0.5))).toBe('500.03');
    expect(d(expectedOf('1000', null))).toBe('0.00');
  });

  it('liquidity days are the cash over the daily spending, whole; null without an account or spending', () => {
    // 90 000 spent in 90 days: 1 000 a day.
    expect(liquidityDays('45999.99', '90000', true)).toBe(45);
    expect(liquidityDays('-10', '90000', true)).toBe(0);
    expect(liquidityDays('5000', '0', true)).toBeNull();
    expect(liquidityDays('5000', '90000', false)).toBeNull();
    expect(d(dailySpending('1000'))).toBe('11.11');
  });

  it('a contract payment leaves less its retention, held to the end', () => {
    const s = splitRetention('1000.00', '10.00');
    expect([d(s.now), d(s.held)]).toEqual(['900.00', '100.00']);
    const none = splitRetention('1000.00', null);
    expect([d(none.now), d(none.held)]).toEqual(['1000.00', '0.00']);
  });

  it('a plan bills from the period holding today, each due after its issue', () => {
    expect(
      planPeriods(
        {
          frequency: 'monthly',
          startsOn: '2026-01-01',
          issueDaysBefore: 5,
          dueDaysAfterIssue: 14,
        },
        1,
        '2026-11-08',
        '2027-01-31',
      ),
    ).toEqual([
      { start: '2026-11-01', dueOn: '2026-11-10' },
      { start: '2026-12-01', dueOn: '2026-12-10' },
      { start: '2027-01-01', dueOn: '2027-01-10' },
    ]);
  });

  it('closing balances run from the opening', () => {
    expect(closings('100', ['-30', '50', '-200']).map(d)).toEqual([
      '70.00',
      '120.00',
      '-80.00',
    ]);
  });
});
