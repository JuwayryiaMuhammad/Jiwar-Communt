import type { ClubDurationKind } from '@prisma/client';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';

// ============================================================================
// A membership's periods (ADR 0044)
// ============================================================================
//
// Every payment pays for a period of local days, its end excluded. A
// membership is active on a day some payment that was not reversed covers.
// Pure: the service feeds them the records it read under the membership's
// lock.

export interface PaidPeriod {
  startsOn: LocalDate;
  /** Excluded. */
  endsOn: LocalDate;
  reversed: boolean;
}

export interface PlanDuration {
  durationKind: ClubDurationKind;
  durationDays: number | null;
}

const MONTHS: Record<Exclude<ClubDurationKind, 'custom'>, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/**
 * `date` plus `n` calendar months: the same day of the month, or the last
 * day of a shorter month (Jan 31 + 1 month = Feb 28, or 29).
 */
export function addMonths(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  const months = y * 12 + (m - 1) + n;
  const year = Math.floor(months / 12);
  const month = months % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The end (excluded) of a period of the plan that starts on `start`. */
export function periodEnd(start: LocalDate, plan: PlanDuration): LocalDate {
  return plan.durationKind === 'custom'
    ? addDays(start, plan.durationDays!)
    : addMonths(start, MONTHS[plan.durationKind]);
}

const live = (periods: readonly PaidPeriod[]) =>
  periods.filter((p) => !p.reversed);

/** Whether a period not reversed covers `day`. */
export const activeOn = (periods: readonly PaidPeriod[], day: LocalDate) =>
  live(periods).some((p) => p.startsOn <= day && day < p.endsOn);

/**
 * Where a new payment's period starts: on the day it was paid, or, when
 * the membership already has a period that is not reversed ending later,
 * where the last of them ends — so payments chain, never pay twice for one
 * day, and one recorded late does not land before what was paid already.
 * A gap a reversal left stays a gap.
 */
export function nextStart(
  periods: readonly PaidPeriod[],
  paidOn: LocalDate,
): LocalDate {
  return live(periods).reduce(
    (start, p) => (p.endsOn > start ? p.endsOn : start),
    paidOn,
  );
}

/**
 * The end (excluded) of the run of periods not reversed that covers `day`,
 * following periods that start where the previous one ends; null when no
 * period covers `day`. The membership is active until the day before.
 */
export function activeUntil(
  periods: readonly PaidPeriod[],
  day: LocalDate,
): LocalDate | null {
  if (!activeOn(periods, day)) return null;
  let end = day;
  for (;;) {
    const covering = live(periods).find(
      (p) => p.startsOn <= end && end < p.endsOn,
    );
    if (!covering) return end;
    end = covering.endsOn;
  }
}
