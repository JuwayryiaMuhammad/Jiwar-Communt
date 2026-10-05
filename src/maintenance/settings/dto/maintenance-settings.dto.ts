import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  AUTO_CLOSE_HOURS,
  MAX_REPORT_PHOTOS,
  REOPEN_DAYS,
  VISIT_HOURS_END,
  VISIT_HOURS_START,
  VISIT_SLOT_MINUTES,
} from '../maintenance-settings.service';

export class UpdateMaintenanceSettingsDto {
  @ApiProperty({
    type: Number,
    required: false,
    minimum: AUTO_CLOSE_HOURS.min,
    maximum: AUTO_CLOSE_HOURS.max,
    description: 'Hours a completed ticket waits for the reporter.',
  })
  @IsOptional()
  @IsInt(withParams({ ...AUTO_CLOSE_HOURS }))
  @Min(AUTO_CLOSE_HOURS.min, withParams({ ...AUTO_CLOSE_HOURS }))
  @Max(AUTO_CLOSE_HOURS.max, withParams({ ...AUTO_CLOSE_HOURS }))
  autoCloseHours?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: REOPEN_DAYS.min,
    maximum: REOPEN_DAYS.max,
    description: 'Days after closing during which the reporter may reopen.',
  })
  @IsOptional()
  @IsInt(withParams({ ...REOPEN_DAYS }))
  @Min(REOPEN_DAYS.min, withParams({ ...REOPEN_DAYS }))
  @Max(REOPEN_DAYS.max, withParams({ ...REOPEN_DAYS }))
  reopenDays?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: MAX_REPORT_PHOTOS.min,
    maximum: MAX_REPORT_PHOTOS.max,
    description: 'Photos the reporter may attach to a ticket.',
  })
  @IsOptional()
  @IsInt(withParams({ ...MAX_REPORT_PHOTOS }))
  @Min(MAX_REPORT_PHOTOS.min, withParams({ ...MAX_REPORT_PHOTOS }))
  @Max(MAX_REPORT_PHOTOS.max, withParams({ ...MAX_REPORT_PHOTOS }))
  maxReportPhotos?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: VISIT_HOURS_START.min,
    maximum: VISIT_HOURS_START.max,
    description:
      'Visiting hours start, minutes after local midnight (ADR 0038).',
  })
  @IsOptional()
  @IsInt(withParams({ ...VISIT_HOURS_START }))
  @Min(VISIT_HOURS_START.min, withParams({ ...VISIT_HOURS_START }))
  @Max(VISIT_HOURS_START.max, withParams({ ...VISIT_HOURS_START }))
  visitHoursStart?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: VISIT_HOURS_END.min,
    maximum: VISIT_HOURS_END.max,
    description:
      'Visiting hours end, minutes after local midnight; at least one slot after the start.',
  })
  @IsOptional()
  @IsInt(withParams({ ...VISIT_HOURS_END }))
  @Min(VISIT_HOURS_END.min, withParams({ ...VISIT_HOURS_END }))
  @Max(VISIT_HOURS_END.max, withParams({ ...VISIT_HOURS_END }))
  visitHoursEnd?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: VISIT_SLOT_MINUTES.min,
    maximum: VISIT_SLOT_MINUTES.max,
    description: 'The length of a slot residents may pick.',
  })
  @IsOptional()
  @IsInt(withParams({ ...VISIT_SLOT_MINUTES }))
  @Min(VISIT_SLOT_MINUTES.min, withParams({ ...VISIT_SLOT_MINUTES }))
  @Max(VISIT_SLOT_MINUTES.max, withParams({ ...VISIT_SLOT_MINUTES }))
  visitSlotMinutes?: number;
}
