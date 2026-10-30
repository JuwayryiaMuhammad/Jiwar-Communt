import { Prisma } from '@prisma/client';
import type { Segment } from './consumption-rules';
import {
  addMonths,
  daysIn,
  householdMonths,
  lastDay,
  median,
} from './household-consumption-rules';

const d = (v: string | number) => new Prisma.Decimal(v);
const seg = (
  month: string,
  days: number,
  use: string,
  cost: string | null = null,
): Segment => ({
  month,
  days,
  use: d(use),
  cost: cost === null ? null : d(cost),
});

describe('household consumption rules (ADR 0069)', () => {
  it('months move across years both ways; a month’s last day and length', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(addMonths('2027-03', -12)).toBe('2026-03');
    expect(addMonths('2027-03', -15)).toBe('2025-12');
    expect(lastDay('2028-02')).toBe('2028-02-29');
    expect(daysIn('2027-02')).toBe(28);
    expect(daysIn('2026-12')).toBe(31);
  });

  it('a month is complete only when every meter read in it covers each of its days', () => {
    const months = householdMonths([
      { meterId: 'a', segment: seg('2027-01', 20, '20', '10') },
      { meterId: 'a', segment: seg('2027-01', 11, '11') },
      { meterId: 'b', segment: seg('2027-01', 31, '31', '5') },
      { meterId: 'a', segment: seg('2027-02', 28, '28') },
      { meterId: 'b', segment: seg('2027-02', 27, '27') },
      { meterId: 'a', segment: seg('2026-12', 5, '5') },
    ]);
    expect(
      months.map((m) => [
        m.month,
        m.use.toFixed(0),
        m.cost?.toFixed(0) ?? null,
        m.complete,
      ]),
    ).toEqual([
      ['2026-12', '5', null, false],
      ['2027-01', '62', '15', true],
      ['2027-02', '55', null, false],
    ]);
  });

  it('the median: the middle value, or the mean of the two middle ones', () => {
    expect(median([])).toBeNull();
    expect(median([d(3), d(1), d(2)])!.toFixed(1)).toBe('2.0');
    expect(median([d(4), d(1), d(3), d(2)])!.toFixed(1)).toBe('2.5');
  });
});
