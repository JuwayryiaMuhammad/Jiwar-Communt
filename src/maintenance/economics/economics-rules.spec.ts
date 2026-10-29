import { Prisma } from '@prisma/client';
import {
  capitalPlan,
  replacementAdvice,
  replacementYear,
  straightLineReserve,
} from './economics-rules';
import { resolvePeriod } from './period';

const d = (v: string) => new Prisma.Decimal(v);
const base = {
  replacementCost: d('10000'),
  cumulative: d('0'),
  lastYear: d('0'),
  ageYears: 3,
  lifeYears: 10,
  sharePct: 50,
};

describe('asset economics, by rule (ADR 0065)', () => {
  it('repair or replace: two rules, each with its reason; no replacement cost, no advice', () => {
    expect(replacementAdvice(base)).toEqual({ advice: 'repair', reasons: [] });
    expect(replacementAdvice({ ...base, cumulative: d('10000') })).toEqual({
      advice: 'replace',
      reasons: ['repairs_exceed_replacement'],
    });
    // Past its life, a year's repairs at half a new one.
    expect(
      replacementAdvice({ ...base, ageYears: 10, lastYear: d('5000') }),
    ).toEqual({ advice: 'replace', reasons: ['past_life_and_costly'] });
    expect(
      replacementAdvice({ ...base, ageYears: 10, lastYear: d('4999.99') }),
    ).toEqual({ advice: 'repair', reasons: [] });
    // The compound's share moves the line.
    expect(
      replacementAdvice({
        ...base,
        ageYears: 12,
        lastYear: d('2000'),
        sharePct: 20,
      }).advice,
    ).toBe('replace');
    // Young and costly is still a repair by the second rule.
    expect(
      replacementAdvice({ ...base, ageYears: 2, lastYear: d('9000') }).advice,
    ).toBe('repair');
    expect(replacementAdvice({ ...base, replacementCost: null })).toEqual({
      advice: 'unknown',
      reasons: ['no_replacement_cost'],
    });
  });

  it('the straight-line reserve: a year’s share, and what has built up, never more than the cost', () => {
    expect(
      straightLineReserve({
        replacementCost: d('12000'),
        ageYears: 3,
        lifeYears: 10,
      }),
    ).toEqual({ annual: d('1200'), accrued: d('3600') });
    expect(
      straightLineReserve({
        replacementCost: d('12000'),
        ageYears: 15,
        lifeYears: 10,
      })?.accrued.toFixed(2),
    ).toBe('12000.00');
    expect(
      straightLineReserve({
        replacementCost: d('1000'),
        ageYears: 1,
        lifeYears: null,
      }),
    ).toBeNull();
  });

  it('the capital plan: each replacement in its year, an overdue one in the first, beyond five years left out', () => {
    expect(replacementYear(2016, 10)).toBe(2026);
    expect(replacementYear(null, 10)).toBeNull();
    const plan = capitalPlan(
      [
        { dueYear: 2020, replacementCost: d('100') },
        { dueYear: 2026, replacementCost: d('50') },
        { dueYear: 2028, replacementCost: d('70') },
        { dueYear: 2031, replacementCost: d('999') },
        { dueYear: null, replacementCost: d('5') },
      ],
      2026,
    );
    expect(plan.map((y) => [y.year, y.amount.toFixed(2), y.assets])).toEqual([
      [2026, '150.00', 2],
      [2027, '0.00', 0],
      [2028, '70.00', 1],
      [2029, '0.00', 0],
      [2030, '0.00', 0],
    ]);
  });

  it('a period: thirty days to today by default, real days in order, a year at most', () => {
    expect(resolvePeriod({}, '2026-10-30')).toEqual({
      from: '2026-10-01',
      to: '2026-10-30',
      days: 30,
    });
    expect(
      resolvePeriod({ from: '2026-01-01', to: '2026-12-31' }, '2026-06-01')
        .days,
    ).toBe(365);
    expect(() => resolvePeriod({ from: '2026-02-30' }, '2026-03-01')).toThrow();
    expect(() =>
      resolvePeriod({ from: '2026-05-02', to: '2026-05-01' }, '2026-06-01'),
    ).toThrow();
    expect(() =>
      resolvePeriod({ from: '2025-01-01', to: '2026-01-02' }, '2026-06-01'),
    ).toThrow();
  });
});
