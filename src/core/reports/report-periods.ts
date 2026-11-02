import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../common/errors';
import { addDays, weekdayOf, type LocalDate } from '../common/slots/day-slots';
import { isRealDate } from '../common/validation/local-date';
import { REPORT_PERIOD_MAX_DAYS, type ReportPeriod } from './report-registry';

/** How often a schedule sends its report (ADR 0086). */
export const REPORT_CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

/** What a report is compared with (ADR 0086). */
export const REPORT_COMPARISONS = [
  'none',
  'previous',
  'last_year',
  'both',
] as const;
export type ReportComparison = (typeof REPORT_COMPARISONS)[number];

/** The formats a report is drawn in. */
export const REPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** Without dates: the thirty days up to today. */
export const REPORT_DEFAULT_DAYS = 30;

/** Days since 1970-01-01 of a calendar date: integer arithmetic, no instant. */
function epochDay(d: LocalDate): number {
  const [y0, m, day] = d.split('-').map(Number);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Calendar days from `a` to `b` (negative when `b` is before). */
export function daysFrom(a: LocalDate, b: LocalDate): number {
  return epochDay(b) - epochDay(a);
}

/**
 * The period a report covers: real days, in order, at most
 * REPORT_PERIOD_MAX_DAYS long; the thirty days up to `today` by default.
 */
export function resolveReportPeriod(
  q: { from?: string; to?: string },
  today: LocalDate,
): ReportPeriod {
  const fields: FieldError[] = (['from', 'to'] as const).flatMap((field) =>
    q[field] !== undefined && !isRealDate(q[field])
      ? [{ field, code: FieldErrorCode.INVALID_FORMAT }]
      : [],
  );
  if (fields.length) throw invalid(fields);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, 1 - REPORT_DEFAULT_DAYS);
  if (to < from)
    throw invalid([{ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START }]);
  return periodOf(from, to, 'from');
}

function periodOf(
  from: LocalDate,
  to: LocalDate,
  field = 'from',
): ReportPeriod {
  const days = daysFrom(from, to) + 1;
  if (days > REPORT_PERIOD_MAX_DAYS)
    throw invalid([
      {
        field,
        code: FieldErrorCode.PERIOD_TOO_LONG,
        params: { max: REPORT_PERIOD_MAX_DAYS },
      },
    ]);
  return { from, to, days };
}

/** The as many days just before it. */
export function previousPeriod(p: ReportPeriod): ReportPeriod {
  const to = addDays(p.from, -1);
  return { from: addDays(to, 1 - p.days), to, days: p.days };
}

/** The same day a year earlier: 29 February is the 28th. */
export function yearEarlier(d: LocalDate): LocalDate {
  const y = Number(d.slice(0, 4)) - 1;
  const md = d.slice(5) === '02-29' ? '02-28' : d.slice(5);
  return `${String(y).padStart(4, '0')}-${md}`;
}

/** The same days a year earlier. */
export function lastYearPeriod(p: ReportPeriod): ReportPeriod {
  const from = yearEarlier(p.from);
  const to = yearEarlier(p.to);
  return { from, to, days: daysFrom(from, to) + 1 };
}

/**
 * The last whole period of a cadence before `today` (ADR 0086): the day
 * before; the week before, Saturday to Friday (the compound's week, its
 * weekend Friday); the month before.
 */
export function cadencePeriod(
  cadence: ReportCadence,
  today: LocalDate,
): ReportPeriod {
  switch (cadence) {
    case 'daily': {
      const d = addDays(today, -1);
      return { from: d, to: d, days: 1 };
    }
    case 'weekly': {
      // Saturday is 6: the days back to the latest Saturday before today's week.
      const sinceSaturday = (weekdayOf(today) + 1) % 7;
      const to = addDays(today, -sinceSaturday - 1);
      return { from: addDays(to, -6), to, days: 7 };
    }
    case 'monthly': {
      const firstOfThis = `${today.slice(0, 7)}-01`;
      const to = addDays(firstOfThis, -1);
      const from = `${to.slice(0, 7)}-01`;
      return { from, to, days: daysFrom(from, to) + 1 };
    }
  }
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
    fields,
  });
