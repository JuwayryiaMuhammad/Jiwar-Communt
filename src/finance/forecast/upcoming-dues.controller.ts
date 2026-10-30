import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { FORECAST_MONTHS } from './forecast-rules';
import {
  UpcomingDuesService,
  type UpcomingDues,
} from './upcoming-dues.service';

const MONTHS = { min: FORECAST_MONTHS.min, max: FORECAST_MONTHS.max } as const;

export class UpcomingDuesQueryDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: MONTHS.min,
    maximum: MONTHS.max,
    default: FORECAST_MONTHS.default,
    description: 'How many months, this one first.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(withParams(MONTHS))
  @Min(MONTHS.min, withParams(MONTHS))
  @Max(MONTHS.max, withParams(MONTHS))
  months?: number;
}

class DuesMonthView {
  @ApiProperty({ type: String, description: 'YYYY-MM.' })
  month: string;
  @ApiProperty({
    type: String,
    description: 'Issued and still owed, due in it.',
  })
  invoiced: string;
  @ApiProperty({
    type: String,
    description: 'What the unit’s plans will issue it, due in it.',
  })
  projected: string;
  @ApiProperty({ type: String })
  total: string;
}

/** What a unit will owe, by month (ADR 0069): a forecast, not a promise. */
export class UpcomingDuesView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'date' })
  asOf: string;
  @ApiProperty({
    type: String,
    description: 'Due before today and still owed.',
  })
  overdue: string;
  @ApiProperty({ type: [DuesMonthView] })
  months: DuesMonthView[];
  @ApiProperty({ type: String })
  credit: string;
  @ApiProperty({
    type: String,
    description: 'Overdue and the months, less the credit; never below zero.',
  })
  net: string;
}

/** A unit's upcoming dues, for whoever sees its money (ADR 0069). */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller('units/:unitId/upcoming-dues')
export class UpcomingDuesController {
  constructor(private readonly dues: UpcomingDuesService) {}

  @Get()
  @ApiOperation({ summary: 'What my unit will owe, by the month it falls due' })
  @ApiOkResponse({ type: UpcomingDuesView })
  get(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: UpcomingDuesQueryDto,
  ): Promise<UpcomingDues> {
    return this.dues.forUnit(unitId, q.months ?? FORECAST_MONTHS.default);
  }
}
