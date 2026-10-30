import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { INSTALMENTS } from '../../instalments/dto/instalments.dto';
import { PLAN_REQUEST_STATUSES } from '../plan-requests.service';

const MONTHS = { min: INSTALMENTS.min, max: INSTALMENTS.max } as const;

/** A payment plan asked for on an invoice (ADR 0069). */
export class AskPlanDto {
  @ApiProperty({
    type: Number,
    minimum: MONTHS.min,
    maximum: MONTHS.max,
    description:
      'Over how many months; at most the compound’s most (`INVALID_VALUE` with `max`).',
  })
  @IsInt(withParams(MONTHS))
  @Min(MONTHS.min, withParams(MONTHS))
  @Max(MONTHS.max, withParams(MONTHS))
  months: number;
}

export class DeclinePlanRequestDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `planRequestDecline`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class PlanRequestQueueDto {
  @ApiPropertyOptional({
    enum: PLAN_REQUEST_STATUSES,
    enumName: 'PlanRequestStatus',
    default: 'pending',
  })
  @IsOptional()
  @IsIn(
    PLAN_REQUEST_STATUSES,
    withParams({ allowed: [...PLAN_REQUEST_STATUSES] }),
  )
  status?: (typeof PLAN_REQUEST_STATUSES)[number];
}

/** How the compound helps residents plan their payments (ADR 0069). */
export class PlanSettingsDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: MONTHS.min,
    maximum: MONTHS.max,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(withParams(MONTHS))
  @Min(MONTHS.min, withParams(MONTHS))
  @Max(MONTHS.max, withParams(MONTHS))
  planMaxMonths?: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'From what an invoice still owes its due-soon notice offers a plan, EGP; null: never.',
  })
  @IsOptional()
  @IsString()
  planOfferMinAmount?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Tell a unit when its next month’s dues rise.',
  })
  @IsOptional()
  @IsBoolean()
  duesNotice?: boolean;
}
