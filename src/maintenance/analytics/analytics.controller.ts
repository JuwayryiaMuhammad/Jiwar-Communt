import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { IsLocalDate } from '../../core/common/validation/local-date';
import { withParams } from '../../core/common/validation/validation-errors';
import { ComplaintsMap } from './complaints-map';
import {
  RECURRENCE_PLACES,
  RecurrenceReports,
  type RecurrencePlace,
} from './recurrence';
import {
  ComplaintsMapView,
  MapAreaView,
  MapBuildingView,
  RecurrenceReportView,
  RecurrenceRowView,
} from './analytics.views';

const MIN = { min: 2, max: 50 };

export class AnalyticsPeriodQueryDto {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Tickets created on or after, the compound’s day.',
  })
  @IsString()
  @IsLocalDate()
  from: string;

  @ApiProperty({
    type: String,
    format: 'date',
    description: 'Created on or before; at most 366 days after `from`.',
  })
  @IsString()
  @IsLocalDate()
  to: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class RecurrenceQueryDto extends AnalyticsPeriodQueryDto {
  @ApiPropertyOptional({
    enum: RECURRENCE_PLACES,
    enumName: 'RecurrencePlace',
    default: 'asset',
  })
  @IsOptional()
  @IsIn(RECURRENCE_PLACES, withParams({ allowed: [...RECURRENCE_PLACES] }))
  by?: RecurrencePlace;

  @ApiPropertyOptional({
    type: Number,
    minimum: MIN.min,
    maximum: MIN.max,
    description:
      'Tickets a row needs; the compound’s `recurrenceMinTickets` by default.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(withParams(MIN))
  @Min(MIN.min, withParams(MIN))
  @Max(MIN.max, withParams(MIN))
  min?: number;
}

/**
 * The maintenance analytics (ADR 0081), for the dispatch: repeat faults by
 * place and category, and where the tickets are. Aggregated in SQL; counts,
 * codes and amounts only.
 */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance')
export class AnalyticsController {
  constructor(
    private readonly recurrence: RecurrenceReports,
    private readonly map: ComplaintsMap,
  ) {}

  @Get('recurrence')
  @ApiOperation({ summary: 'Repeat faults by place and category' })
  @ApiOkResponse({ type: RecurrenceReportView })
  async recurrenceReport(
    @Query() q: RecurrenceQueryDto,
  ): Promise<RecurrenceReportView> {
    const r = await this.recurrence.report(q);
    return { ...r, rows: r.rows.map((row) => RecurrenceRowView.from(row)) };
  }

  @Get('complaints-map')
  @ApiOperation({ summary: 'Where the tickets are, by building and area' })
  @ApiOkResponse({ type: ComplaintsMapView })
  async complaintsMap(
    @Query() q: AnalyticsPeriodQueryDto,
  ): Promise<ComplaintsMapView> {
    const m = await this.map.read(q);
    return {
      from: m.from,
      to: m.to,
      buildings: m.buildings.map((b) => MapBuildingView.from(b)),
      areas: m.areas.map((a) => MapAreaView.from(a)),
    };
  }
}
