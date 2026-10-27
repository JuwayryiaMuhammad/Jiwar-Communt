import {
  firstOnOrAfter,
  intervalAfter,
  nextAfter,
  occurrence,
} from './recurrence';

describe('recurrence on the compound’s calendar (ADR 0064)', () => {
  it('days and weeks step from the anchor', () => {
    const r = { every: 10, unit: 'day' as const, anchorOn: '2026-12-25' };
    expect([0, 1, 2].map((k) => occurrence(r, k))).toEqual([
      '2026-12-25',
      '2027-01-04',
      '2027-01-14',
    ]);
    expect(
      occurrence({ every: 2, unit: 'week', anchorOn: '2026-10-25' }, 1),
    ).toBe('2026-11-08');
  });

  it('a month keeps the anchor’s day, clamped to the month’s last, never drifting', () => {
    const r = { every: 1, unit: 'month' as const, anchorOn: '2027-01-31' };
    expect([0, 1, 2, 3].map((k) => occurrence(r, k))).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]);
    expect(
      occurrence({ every: 1, unit: 'year', anchorOn: '2028-02-29' }, 1),
    ).toBe('2029-02-28');
    expect(
      occurrence({ every: 1, unit: 'year', anchorOn: '2028-02-29' }, 4),
    ).toBe('2032-02-29');
    expect(
      occurrence({ every: 3, unit: 'month', anchorOn: '2026-11-30' }, 1),
    ).toBe('2027-02-28');
  });

  it('the first date on or after a day, and the next after a due date', () => {
    const r = { every: 1, unit: 'month' as const, anchorOn: '2026-01-31' };
    expect(firstOnOrAfter(r, '2025-06-01')).toBe('2026-01-31');
    expect(firstOnOrAfter(r, '2026-03-01')).toBe('2026-03-31');
    expect(firstOnOrAfter(r, '2026-03-31')).toBe('2026-03-31');
    expect(nextAfter(r, '2026-03-31')).toBe('2026-04-30');
    const daily = { every: 3, unit: 'day' as const, anchorOn: '2026-01-01' };
    expect(firstOnOrAfter(daily, '2026-10-27')).toBe('2026-10-28');
    expect(nextAfter(daily, '2026-10-28')).toBe('2026-10-31');
  });

  it('a floating series: one interval after the day it was done', () => {
    expect(intervalAfter({ every: 6, unit: 'month' }, '2026-08-31')).toBe(
      '2027-02-28',
    );
    expect(intervalAfter({ every: 90, unit: 'day' }, '2026-10-27')).toBe(
      '2027-01-25',
    );
  });
});
