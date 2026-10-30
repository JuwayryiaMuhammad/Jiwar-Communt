import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PeriodQueryDto } from '../../economics/period';
import { METER_KINDS, type MeterKind } from '../meter-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A household's consumption over a period of days (ADR 0069). */
export class HouseholdConsumptionQueryDto extends PeriodQueryDto {
  @ApiPropertyOptional({
    enum: METER_KINDS,
    enumName: 'MeterKind',
    description: 'One kind; every kind the unit has a meter of when left out.',
  })
  @IsOptional()
  @IsIn(METER_KINDS, allowed(METER_KINDS))
  kind?: MeterKind;
}

/** A household's month against other homes of its building (ADR 0069). */
export class ConsumptionBenchmarkQueryDto {
  @ApiProperty({ enum: METER_KINDS, enumName: 'MeterKind' })
  @IsIn(METER_KINDS, allowed(METER_KINDS))
  kind: MeterKind;

  @ApiProperty({
    type: String,
    example: '2027-01',
    description: '`YYYY-MM`, a month that has ended.',
  })
  @IsString()
  @Matches(MONTH, withParams({ format: 'YYYY-MM' }))
  month: string;
}
