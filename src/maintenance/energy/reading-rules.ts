import { Prisma } from '@prisma/client';
import { daysBetween, type LocalDate } from '../schedules/local-dates';
import type { MeterMode } from './meter-rules';

/** Who wrote a reading (ADR 0066); the migration's CHECK repeats them. */
export const READING_SOURCES = ['manual', 'import', 'technician'] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];

/** What an alert says; spikes only for now (ADR 0066). */
export const ALERT_KINDS = ['spike'] as const;

/** A reading as entered: up to 12 digits and four decimals, never negative. */
export const READING_VALUE = /^\d{1,12}(\.\d{1,4})?$/;
/** How far back a reading may be entered: the compound's days. */
export const READING_PAST_DAYS = 400;
/** Fewer earlier periods than this, and a mean says nothing. */
export const SPIKE_MIN_PERIODS = 3;

export interface ReadingPoint {
  readOn: LocalDate;
  value: Prisma.Decimal;
  reset: boolean;
}

export type NeighbourProblem =
  | { code: 'READING_BELOW_PREVIOUS'; params: { previous: string } }
  | { code: 'READING_ABOVE_NEXT'; params: { next: string } };

/** Four decimals, as the API shows a reading. */
export const reading = (v: Prisma.Decimal) => v.toFixed(4);

/**
 * A cumulative register only climbs: a reading is not below the live
 * reading before it, unless it is a reset (the register started again),
 * and not above the live reading after it, unless that one is a reset.
 * Backdated readings are checked on both sides (ADR 0066). An interval
 * meter has no order to keep.
 */
export function neighbourProblem(
  mode: MeterMode,
  r: { value: Prisma.Decimal; reset: boolean },
  previous: ReadingPoint | null,
  next: ReadingPoint | null,
): NeighbourProblem | null {
  if (mode !== 'cumulative') return null;
  if (previous && !r.reset && r.value.lt(previous.value))
    return {
      code: 'READING_BELOW_PREVIOUS',
      params: { previous: reading(previous.value) },
    };
  if (next && !next.reset && r.value.gt(next.value))
    return {
      code: 'READING_ABOVE_NEXT',
      params: { next: reading(next.value) },
    };
  return null;
}

/**
 * What was used from one live reading to the next, in the kind's unit:
 * the register's climb (from zero after a reset), or the interval's
 * figure, times the multiplier.
 */
export function periodUse(
  mode: MeterMode,
  multiplier: Prisma.Decimal,
  previous: ReadingPoint,
  current: ReadingPoint,
): Prisma.Decimal {
  const raw =
    mode === 'interval' || current.reset
      ? current.value
      : current.value.minus(previous.value);
  return raw.times(multiplier);
}

export interface Period {
  from: LocalDate;
  to: LocalDate;
  days: number;
  use: Prisma.Decimal;
  /** Use a day over the period. */
  rate: Prisma.Decimal;
}

/** The periods between consecutive live readings, oldest first. */
export function periods(
  mode: MeterMode,
  multiplier: Prisma.Decimal,
  points: readonly ReadingPoint[],
): Period[] {
  const out: Period[] = [];
  for (let i = 1; i < points.length; i++) {
    const days = daysBetween(points[i - 1].readOn, points[i].readOn);
    if (days <= 0) continue;
    const use = periodUse(mode, multiplier, points[i - 1], points[i]);
    out.push({
      from: points[i - 1].readOn,
      to: points[i].readOn,
      days,
      use,
      rate: use.dividedBy(days),
    });
  }
  return out;
}

/** The mean daily rate of the periods, or null without SPIKE_MIN_PERIODS. */
export function meanRate(ps: readonly Period[]): Prisma.Decimal | null {
  if (ps.length < SPIKE_MIN_PERIODS) return null;
  const days = ps.reduce((n, p) => n + p.days, 0);
  const use = ps.reduce((s, p) => s.plus(p.use), new Prisma.Decimal(0));
  return use.dividedBy(days);
}

/**
 * A spike (ADR 0066): the last period's daily use is above the mean of the
 * `count` periods before it times `factor`. Needs a mean of at least
 * SPIKE_MIN_PERIODS periods and above zero.
 */
export function spike(
  ps: readonly Period[],
  count: number,
  factor: Prisma.Decimal,
): { rate: Prisma.Decimal; baseline: Prisma.Decimal } | null {
  if (ps.length < 2) return null;
  const last = ps[ps.length - 1];
  const baseline = meanRate(ps.slice(0, -1).slice(-count));
  if (!baseline || baseline.lte(0)) return null;
  return last.rate.gt(baseline.times(factor))
    ? { rate: last.rate, baseline }
    : null;
}

/**
 * The range a technician's reading is expected in today (ADR 0066), in the
 * register's own figures: from the last reading (or 0 for an interval
 * meter) to that plus the mean daily use, over the days since, times the
 * spike factor. Null `to` without a mean.
 */
export function expectedRange(
  mode: MeterMode,
  multiplier: Prisma.Decimal,
  last: ReadingPoint | null,
  mean: Prisma.Decimal | null,
  today: LocalDate,
  factor: Prisma.Decimal,
): { from: string; to: string | null } | null {
  if (!last) return null;
  const days = Math.max(1, daysBetween(last.readOn, today));
  const ahead = mean
    ? mean.dividedBy(multiplier).times(days).times(factor)
    : null;
  const base = mode === 'cumulative' ? last.value : new Prisma.Decimal(0);
  return {
    from: reading(base),
    to: ahead ? reading(base.plus(ahead)) : null,
  };
}
