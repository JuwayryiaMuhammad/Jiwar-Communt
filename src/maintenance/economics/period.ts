import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  addDays,
  daysBetween,
  isRealDate,
  LOCAL_DATE,
  type LocalDate,
} from '../schedules/local-dates';

/** A period of the compound's days, both ends included. */
export interface Period {
  from: LocalDate;
  to: LocalDate;
  /** How many days it holds. */
  days: number;
}

/** The longest period a report covers. */
export const PERIOD_MAX_DAYS = 366;
/** Without dates: the thirty days up to today. */
export const PERIOD_DEFAULT_DAYS = 30;

export class PeriodQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description:
      'The first day, the compound’s; 29 days before `to` when left out.',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'The last day, included; today when left out.',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  to?: string;
}

/**
 * The period a report covers (ADR 0065): real days, in order, at most
 * PERIOD_MAX_DAYS long; the thirty days up to `today` by default.
 */
export function resolvePeriod(
  q: { from?: string; to?: string },
  today: LocalDate,
): Period {
  const fields: FieldError[] = (['from', 'to'] as const).flatMap((field) =>
    q[field] !== undefined && !isRealDate(q[field])
      ? [{ field, code: FieldErrorCode.INVALID_FORMAT }]
      : [],
  );
  if (fields.length) throw invalid(fields);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, 1 - PERIOD_DEFAULT_DAYS);
  if (to < from)
    throw invalid([{ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START }]);
  const days = daysBetween(from, to) + 1;
  if (days > PERIOD_MAX_DAYS)
    throw invalid([
      {
        field: 'from',
        code: FieldErrorCode.PERIOD_TOO_LONG,
        params: { max: PERIOD_MAX_DAYS },
      },
    ]);
  return { from, to, days };
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
    fields,
  });
