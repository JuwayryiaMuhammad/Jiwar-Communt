import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  CASH_FLOW_BY,
  CASH_FLOW_PERIODS,
  CASH_MINIMUM,
  type CashFlowBy,
} from './cash-flow-rules';

/** The widest a forecast reads: 26 weeks (12 months, by month). */
const PERIODS = { min: 1, max: CASH_FLOW_PERIODS.week.max } as const;

export class CashFlowQueryDto {
  @ApiPropertyOptional({
    enum: CASH_FLOW_BY,
    default: 'week',
    description:
      'The compound’s weeks, Saturday to Friday, or its calendar months; the first starts today.',
  })
  @IsOptional()
  @IsIn(CASH_FLOW_BY, withParams({ allowed: [...CASH_FLOW_BY] }))
  by?: CashFlowBy;

  @ApiPropertyOptional({
    type: Number,
    minimum: PERIODS.min,
    maximum: PERIODS.max,
    description:
      'How many periods, this one first: 13 weeks or 6 months by default; at most 26 weeks or 12 months (INVALID_NUMBER).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(withParams(PERIODS))
  @Min(PERIODS.min, withParams(PERIODS))
  @Max(PERIODS.max, withParams(PERIODS))
  periods?: number;
}

export class CashFlowSettingsDto {
  @ApiProperty({
    type: String,
    nullable: true,
    pattern: CASH_MINIMUM.source,
    description:
      'The least cash the compound wants to hold, in EGP: the forecast flags a period closing below it and its holders are told once a dip. Null: no floor, no notice.',
  })
  @ValidateIf((o: { minimumCash: unknown }) => o.minimumCash !== null)
  @IsString()
  @Matches(CASH_MINIMUM)
  minimumCash: string | null;
}
