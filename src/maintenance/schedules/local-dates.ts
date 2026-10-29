import {
  addDays,
  localDate,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import {
  IsLocalDate,
  isRealDate,
  LOCAL_DATE,
} from '../../core/common/validation/local-date';

/**
 * Dates of the compound's calendar (ADR 0064): a due date, a warranty's
 * end, a commissioning day. `YYYY-MM-DD` in the API, a day that exists
 * (`@IsLocalDate()`); a DATE column in the database, which Prisma hands
 * over as midnight UTC. Arithmetic is on the date itself, never on
 * instants, so a DST change moves nothing.
 */
export { IsLocalDate, isRealDate, LOCAL_DATE };

/** A DATE column's value from `YYYY-MM-DD`. */
export const dateColumn = (value: LocalDate): Date =>
  new Date(`${value}T00:00:00Z`);

/** `YYYY-MM-DD` from a DATE column's value. */
export const ofDateColumn = (d: Date): LocalDate =>
  d.toISOString().slice(0, 10);

export const ofDateColumnOrNull = (d: Date | null): LocalDate | null =>
  d === null ? null : ofDateColumn(d);

/** The compound's day of an instant. */
export const compoundDay = (instant: Date, timeZone: string): LocalDate =>
  localDate(instant, timeZone);

/** Whole days from `a` to `b` (negative when `b` is before). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round(
    (dateColumn(b).getTime() - dateColumn(a).getTime()) / 86_400_000,
  );
}

/** Whole years from `from` to `to`, as a birthday counts them. */
export function wholeYears(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let years = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) years--;
  return years;
}

export { addDays, type LocalDate };
