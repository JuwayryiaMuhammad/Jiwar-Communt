import { Prisma } from '@prisma/client';
import { addDays, daysBetween, type LocalDate } from '../schedules/local-dates';
import type { Segment } from './consumption-rules';

/**
 * The fewest other units a benchmark compares a household with (ADR 0069):
 * the turnout rule of ADR 0040, with the household's own unit left out, so
 * no figure is ever another unit's own.
 */
export const BENCHMARK_MIN_UNITS = 5;

/** A month, `YYYY-MM`, `n` months later (earlier when negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export const firstDay = (month: string): LocalDate => `${month}-01`;

export const lastDay = (month: string): LocalDate =>
  addDays(firstDay(addMonths(month, 1)), -1);

export const daysIn = (month: string): number =>
  daysBetween(firstDay(month), lastDay(month)) + 1;

export interface HouseholdMonth {
  month: string;
  use: Prisma.Decimal;
  /** Null where no day was priced. */
  cost: Prisma.Decimal | null;
  /**
   * Every meter read in the month covers each of its days: the household
   * lived there all month and the readings span it. Only complete months
   * are compared.
   */
  complete: boolean;
}

/** The household's use by month, oldest first, from its meters' segments. */
export function householdMonths(
  parts: readonly { meterId: string; segment: Segment }[],
): HouseholdMonth[] {
  const byMonth = new Map<string, Map<string, Segment[]>>();
  for (const { meterId, segment } of parts) {
    const meters = byMonth.get(segment.month) ?? new Map<string, Segment[]>();
    meters.set(meterId, [...(meters.get(meterId) ?? []), segment]);
    byMonth.set(segment.month, meters);
  }
  return [...byMonth.entries()]
    .sort(([a], [z]) => (a < z ? -1 : 1))
    .map(([month, meters]) => {
      const all = [...meters.values()].flat();
      const priced = all.filter((s) => s.cost !== null);
      return {
        month,
        use: all.reduce((n, s) => n.plus(s.use), new Prisma.Decimal(0)),
        cost: priced.length
          ? priced.reduce((n, s) => n.plus(s.cost!), new Prisma.Decimal(0))
          : null,
        complete: [...meters.values()].every(
          (ss) => ss.reduce((n, s) => n + s.days, 0) === daysIn(month),
        ),
      };
    });
}

/** The median of the values; null without any. */
export function median(
  values: readonly Prisma.Decimal[],
): Prisma.Decimal | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : sorted[mid - 1].plus(sorted[mid]).dividedBy(2);
}
