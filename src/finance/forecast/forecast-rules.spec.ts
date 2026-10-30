import { Prisma } from '@prisma/client';
import { monthPlus, projectedDues, rising } from './forecast-rules';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('upcoming dues (ADR 0069)', () => {
  const monthly = {
    frequency: 'monthly' as const,
    startsOn: '2027-01-01',
    issueDaysBefore: 7,
    dueDaysAfterIssue: 10,
  };

  it('a plan’s periods from the one holding today, not issued yet, due by its issue day and days to pay', () => {
    expect(
      projectedDues(
        monthly,
        d('500'),
        new Set(['2027-03-01']),
        '2027-03-15',
        '2027-06-30',
      ).map((x) => x.dueOn),
    ).toEqual(['2027-04-04', '2027-05-04', '2027-06-04']);
  });

  it('a quarterly plan, and one that has not started', () => {
    expect(
      projectedDues(
        { ...monthly, frequency: 'quarterly', startsOn: '2027-07-01' },
        d('900'),
        new Set(),
        '2027-03-15',
        '2027-12-31',
      ).map((x) => x.dueOn),
    ).toEqual(['2027-07-04', '2027-10-04']);
  });

  it('months move across years', () => {
    expect(monthPlus('2027-11', 3)).toBe('2028-02');
  });

  it('next month rises above one and a half times the months before, with three that asked at least', () => {
    const six = [d(0), d(0), d(0), d(500), d(500), d(500)];
    expect(rising(d(400), six)).toBe(true);
    expect(rising(d(375), six)).toBe(false);
    expect(rising(d(5000), [d(0), d(0), d(0), d(0), d(500), d(500)])).toBe(
      false,
    );
  });
});
