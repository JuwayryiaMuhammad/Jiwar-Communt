import {
  addDays,
  dateColumn,
  daysBetween,
  isRealDate,
  ofDateColumn,
  wholeYears,
} from './local-dates';

describe('compound dates (ADR 0064)', () => {
  it('real days only', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    for (const bad of [
      '2026-02-29',
      '2026-04-31',
      '2026-13-01',
      '26-01-01',
      '',
    ])
      expect(isRealDate(bad)).toBe(false);
  });

  it('a DATE column round-trips; days and years count as a calendar does', () => {
    expect(ofDateColumn(dateColumn('2026-10-25'))).toBe('2026-10-25');
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2026-03-01', '2026-02-27')).toBe(-2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(wholeYears('2016-10-28', '2026-10-27')).toBe(9);
    expect(wholeYears('2016-10-27', '2026-10-27')).toBe(10);
  });
});
