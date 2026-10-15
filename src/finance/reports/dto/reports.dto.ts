import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { LOCAL_DATE } from '../../invoices/dto/invoices.dto';
import { PeriodDto } from './ledger.dto';

const BUILDING = { min: 1, max: 100 } as const;
export const UNIT_GROUPS = ['unit', 'building'] as const;
export const PERIOD_GROUPS = ['day', 'month'] as const;

/** Aging and outstanding: per unit or per building, one building or all. */
export class UnitReportQueryDto {
  @ApiProperty({
    required: false,
    type: String,
    enum: UNIT_GROUPS,
    default: 'unit',
  })
  @IsOptional()
  @IsIn(UNIT_GROUPS, withParams({ allowed: [...UNIT_GROUPS] }))
  groupBy: (typeof UNIT_GROUPS)[number] = 'unit';

  @ApiProperty({
    required: false,
    type: String,
    maxLength: BUILDING.max,
    description: 'Units whose building reads exactly this.',
  })
  @IsOptional()
  @IsString()
  @Length(BUILDING.min, BUILDING.max, withParams(BUILDING))
  building?: string;
}

export class CollectionsQueryDto extends PeriodDto {
  @ApiProperty({
    required: false,
    type: String,
    enum: PERIOD_GROUPS,
    default: 'day',
  })
  @IsOptional()
  @IsIn(PERIOD_GROUPS, withParams({ allowed: [...PERIOD_GROUPS] }))
  groupBy: (typeof PERIOD_GROUPS)[number] = 'day';
}

export class DailyCashQueryDto {
  @ApiProperty({
    required: false,
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The local day closed; today when left out.',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  day?: string;
}
