import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  AnalyticsSettingsService,
  CASE_MIN_TICKETS,
  CASE_WINDOW_DAYS,
  RECURRENCE_MIN_TICKETS,
  RECURRENCE_WINDOW_DAYS,
  type AnalyticsSettings,
} from './analytics-settings.service';

export class AnalyticsSettingsView {
  @ApiProperty({
    type: Number,
    description:
      'Repairs of one category on one asset (else in one unit) within the window that make a plan suggestion.',
  })
  recurrenceMinTickets: number;
  @ApiProperty({ type: Number, description: 'Their window, days.' })
  recurrenceWindowDays: number;
  @ApiProperty({
    type: Number,
    description:
      'Residents’ tickets of one category in one building within the window that make a community case.',
  })
  caseMinTickets: number;
  @ApiProperty({ type: Number, description: 'Their window, days.' })
  caseWindowDays: number;
}

export class UpdateAnalyticsSettingsDto {
  @ApiProperty({
    type: Number,
    required: false,
    minimum: RECURRENCE_MIN_TICKETS.min,
    maximum: RECURRENCE_MIN_TICKETS.max,
  })
  @IsOptional()
  @IsInt(withParams({ ...RECURRENCE_MIN_TICKETS }))
  @Min(RECURRENCE_MIN_TICKETS.min, withParams({ ...RECURRENCE_MIN_TICKETS }))
  @Max(RECURRENCE_MIN_TICKETS.max, withParams({ ...RECURRENCE_MIN_TICKETS }))
  recurrenceMinTickets?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: RECURRENCE_WINDOW_DAYS.min,
    maximum: RECURRENCE_WINDOW_DAYS.max,
  })
  @IsOptional()
  @IsInt(withParams({ ...RECURRENCE_WINDOW_DAYS }))
  @Min(RECURRENCE_WINDOW_DAYS.min, withParams({ ...RECURRENCE_WINDOW_DAYS }))
  @Max(RECURRENCE_WINDOW_DAYS.max, withParams({ ...RECURRENCE_WINDOW_DAYS }))
  recurrenceWindowDays?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: CASE_MIN_TICKETS.min,
    maximum: CASE_MIN_TICKETS.max,
  })
  @IsOptional()
  @IsInt(withParams({ ...CASE_MIN_TICKETS }))
  @Min(CASE_MIN_TICKETS.min, withParams({ ...CASE_MIN_TICKETS }))
  @Max(CASE_MIN_TICKETS.max, withParams({ ...CASE_MIN_TICKETS }))
  caseMinTickets?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: CASE_WINDOW_DAYS.min,
    maximum: CASE_WINDOW_DAYS.max,
  })
  @IsOptional()
  @IsInt(withParams({ ...CASE_WINDOW_DAYS }))
  @Min(CASE_WINDOW_DAYS.min, withParams({ ...CASE_WINDOW_DAYS }))
  @Max(CASE_WINDOW_DAYS.max, withParams({ ...CASE_WINDOW_DAYS }))
  caseWindowDays?: number;
}

const toView = (s: AnalyticsSettings): AnalyticsSettingsView => ({ ...s });

/** When repeat faults suggest a plan and reports make a case (ADR 0081). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/settings/analytics')
export class AnalyticsSettingsController {
  constructor(private readonly settings: AnalyticsSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get the maintenance analytics settings' })
  @ApiOkResponse({ type: AnalyticsSettingsView })
  async get(): Promise<AnalyticsSettingsView> {
    return toView(await this.settings.get());
  }

  @Patch()
  @ApiOperation({ summary: 'Update the maintenance analytics settings' })
  @ApiOkResponse({ type: AnalyticsSettingsView })
  async update(
    @Body() dto: UpdateAnalyticsSettingsDto,
  ): Promise<AnalyticsSettingsView> {
    return toView(await this.settings.update(dto));
  }
}
