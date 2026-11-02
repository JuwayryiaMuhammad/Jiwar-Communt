import {
  cadencePeriod,
  daysFrom,
  lastYearPeriod,
  previousPeriod,
  resolveReportPeriod,
  yearEarlier,
} from './report-periods';

describe('report periods (ADR 0086)', () => {
  it('counts calendar days, across a leap day and a year', () => {
    expect(daysFrom('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysFrom('2027-02-28', '2027-03-01')).toBe(1);
    expect(daysFrom('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysFrom('2027-01-01', '2026-12-31')).toBe(-1);
    expect(daysFrom('2026-01-01', '2027-01-01')).toBe(365);
  });

  it('a period: thirty days to today by default, at most 366, real days in order', () => {
    expect(resolveReportPeriod({}, '2026-11-30')).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      days: 30,
    });
    expect(() =>
      resolveReportPeriod(
        { from: '2026-02-30', to: '2026-03-01' },
        '2026-11-30',
      ),
    ).toThrow();
    expect(() =>
      resolveReportPeriod(
        { from: '2026-03-02', to: '2026-03-01' },
        '2026-11-30',
      ),
    ).toThrow();
    expect(() =>
      resolveReportPeriod(
        { from: '2025-01-01', to: '2026-01-02' },
        '2026-11-30',
      ),
    ).toThrow();
    expect(
      resolveReportPeriod(
        { from: '2027-01-01', to: '2027-12-31' },
        '2027-12-31',
      ).days,
    ).toBe(365);
  });

  it('the period before holds as many days, ending the day before', () => {
    expect(
      previousPeriod({ from: '2026-11-01', to: '2026-11-30', days: 30 }),
    ).toEqual({ from: '2026-10-02', to: '2026-10-31', days: 30 });
  });

  it('a year earlier: the same days, 29 February the 28th', () => {
    expect(yearEarlier('2028-02-29')).toBe('2027-02-28');
    expect(
      lastYearPeriod({ from: '2026-10-01', to: '2026-10-31', days: 31 }),
    ).toEqual({ from: '2025-10-01', to: '2025-10-31', days: 31 });
    expect(
      lastYearPeriod({ from: '2028-02-01', to: '2028-02-29', days: 29 }),
    ).toEqual({ from: '2027-02-01', to: '2027-02-28', days: 28 });
  });

  it('a cadence’s last whole period before today', () => {
    expect(cadencePeriod('daily', '2026-11-01')).toEqual({
      from: '2026-10-31',
      to: '2026-10-31',
      days: 1,
    });
    // 2026-11-07 is a Saturday: the week before ended yesterday, Friday.
    expect(cadencePeriod('weekly', '2026-11-07')).toEqual({
      from: '2026-10-31',
      to: '2026-11-06',
      days: 7,
    });
    // A Friday: its own week is not whole yet.
    expect(cadencePeriod('weekly', '2026-11-06')).toEqual({
      from: '2026-10-24',
      to: '2026-10-30',
      days: 7,
    });
    expect(cadencePeriod('monthly', '2026-03-15')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
      days: 28,
    });
    expect(cadencePeriod('monthly', '2027-01-01')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
      days: 31,
    });
  });
});
