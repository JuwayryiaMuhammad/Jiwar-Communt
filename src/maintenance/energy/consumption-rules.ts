import { Prisma } from '@prisma/client';
import { addDays, daysBetween, type LocalDate } from '../schedules/local-dates';

/** What consumption is grouped by (ADR 0066). */
export const CONSUMPTION_GROUPS = ['meter', 'building', 'area'] as const;
export type ConsumptionGroup = (typeof CONSUMPTION_GROUPS)[number];

/** A tariff in force from a day on. */
export interface TariffPoint {
  effectiveOn: LocalDate;
  pricePerUnit: Prisma.Decimal;
}

/** A piece of a period: days in one month, under one tariff. */
export interface Segment {
  month: string;
  days: number;
  use: Prisma.Decimal;
  /** Null without a tariff in force. */
  cost: Prisma.Decimal | null;
}

export const monthOf = (d: LocalDate) => d.slice(0, 7);

/** The first day of the month after `d`'s. */
function nextMonthStart(d: LocalDate): LocalDate {
  const [y, m] = d.split('-').map(Number);
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** The tariff in force on a day: the latest from on or before it. */
export function priceOn(
  tariffs: readonly TariffPoint[],
  day: LocalDate,
): Prisma.Decimal | null {
  let price: Prisma.Decimal | null = null;
  for (const t of tariffs) if (t.effectiveOn <= day) price = t.pricePerUnit;
  return price;
}

/**
 * A period's use spread evenly over its days — the days after the earlier
 * reading up to the later one — and the part inside the window, cut where
 * a month or a tariff changes (ADR 0066). Tariffs oldest first.
 */
export function spread(
  period: { from: LocalDate; to: LocalDate; use: Prisma.Decimal },
  window: { from: LocalDate; to: LocalDate },
  tariffs: readonly TariffPoint[],
): Segment[] {
  const days = daysBetween(period.from, period.to);
  if (days <= 0) return [];
  const daily = period.use.dividedBy(days);
  const first = [addDays(period.from, 1), window.from].sort()[1];
  const last = [period.to, window.to].sort()[0];
  const out: Segment[] = [];
  let start = first;
  while (start <= last) {
    const cuts = [
      nextMonthStart(start),
      ...tariffs.map((t) => t.effectiveOn).filter((d) => d > start),
      addDays(last, 1),
    ].sort();
    const end = addDays(cuts[0], -1);
    const n = daysBetween(start, end) + 1;
    const use = daily.times(n);
    const price = priceOn(tariffs, start);
    out.push({
      month: monthOf(start),
      days: n,
      use,
      cost: price ? use.times(price) : null,
    });
    start = cuts[0];
  }
  return out;
}

/** Two decimals, as money; four for use. */
export const money = (v: Prisma.Decimal) => v.toDecimalPlaces(2).toFixed(2);
export const amount = (v: Prisma.Decimal) => v.toDecimalPlaces(4).toFixed(4);

/** The days a measure is read over, before and after (ADR 0066): whole weeks. */
export const MEASURE_WEEKS = { min: 1, max: 26, default: 4 } as const;

/**
 * A measure's effect: the use over `weeks` weeks before its start against
 * the same number of weeks from it — whole weeks, so each side holds the
 * same days of the week. The after side stops at today or its end; it is
 * complete only once it has all its days.
 */
export function measureWindows(
  startsOn: LocalDate,
  weeks: number,
  until: LocalDate,
): {
  before: { from: LocalDate; to: LocalDate };
  after: { from: LocalDate; to: LocalDate } | null;
  complete: boolean;
} {
  const days = weeks * 7;
  const afterTo = addDays(startsOn, days - 1);
  const to = afterTo <= until ? afterTo : until;
  return {
    before: { from: addDays(startsOn, -days), to: addDays(startsOn, -1) },
    after: to >= startsOn ? { from: startsOn, to } : null,
    complete: afterTo <= until,
  };
}
