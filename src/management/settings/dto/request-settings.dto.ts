import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  END_MINUTE,
  MAX_WINDOWS,
  START_MINUTE,
  WEEKDAY,
} from '../office-hours-rules';
import {
  APPOINTMENT_SLOT_CAPACITY,
  APPOINTMENT_SLOT_MINUTES,
  AUTO_CLOSE_DAYS,
} from '../request-settings.service';

export class UpdateRequestSettingsDto {
  @ApiProperty({
    type: Number,
    required: false,
    minimum: AUTO_CLOSE_DAYS.min,
    maximum: AUTO_CLOSE_DAYS.max,
    description:
      'Days an answered request waits for its author before it closes itself.',
  })
  @IsOptional()
  @IsInt(withParams({ ...AUTO_CLOSE_DAYS }))
  @Min(AUTO_CLOSE_DAYS.min, withParams({ ...AUTO_CLOSE_DAYS }))
  @Max(AUTO_CLOSE_DAYS.max, withParams({ ...AUTO_CLOSE_DAYS }))
  autoCloseDays?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: APPOINTMENT_SLOT_MINUTES.min,
    maximum: APPOINTMENT_SLOT_MINUTES.max,
    description: 'The length of an appointment slot, in minutes.',
  })
  @IsOptional()
  @IsInt(withParams({ ...APPOINTMENT_SLOT_MINUTES }))
  @Min(
    APPOINTMENT_SLOT_MINUTES.min,
    withParams({ ...APPOINTMENT_SLOT_MINUTES }),
  )
  @Max(
    APPOINTMENT_SLOT_MINUTES.max,
    withParams({ ...APPOINTMENT_SLOT_MINUTES }),
  )
  appointmentSlotMinutes?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: APPOINTMENT_SLOT_CAPACITY.min,
    maximum: APPOINTMENT_SLOT_CAPACITY.max,
    description: 'Appointments one slot takes.',
  })
  @IsOptional()
  @IsInt(withParams({ ...APPOINTMENT_SLOT_CAPACITY }))
  @Min(
    APPOINTMENT_SLOT_CAPACITY.min,
    withParams({ ...APPOINTMENT_SLOT_CAPACITY }),
  )
  @Max(
    APPOINTMENT_SLOT_CAPACITY.max,
    withParams({ ...APPOINTMENT_SLOT_CAPACITY }),
  )
  appointmentSlotCapacity?: number;
}

export class OfficeWindowDto {
  @ApiProperty({
    type: Number,
    minimum: WEEKDAY.min,
    maximum: WEEKDAY.max,
    description: '0 is Sunday, 6 is Saturday.',
  })
  @IsInt(withParams({ ...WEEKDAY }))
  @Min(WEEKDAY.min, withParams({ ...WEEKDAY }))
  @Max(WEEKDAY.max, withParams({ ...WEEKDAY }))
  weekday: number;

  @ApiProperty({
    type: Number,
    minimum: START_MINUTE.min,
    maximum: START_MINUTE.max,
    description: 'Minutes after midnight in the compound’s time zone.',
  })
  @IsInt(withParams({ ...START_MINUTE }))
  @Min(START_MINUTE.min, withParams({ ...START_MINUTE }))
  @Max(START_MINUTE.max, withParams({ ...START_MINUTE }))
  startMinute: number;

  @ApiProperty({
    type: Number,
    minimum: END_MINUTE.min,
    maximum: END_MINUTE.max,
    description: 'Minutes after local midnight; after the start.',
  })
  @IsInt(withParams({ ...END_MINUTE }))
  @Min(END_MINUTE.min, withParams({ ...END_MINUTE }))
  @Max(END_MINUTE.max, withParams({ ...END_MINUTE }))
  endMinute: number;
}

export class ReplaceOfficeHoursDto {
  @ApiProperty({
    type: [OfficeWindowDto],
    maxItems: MAX_WINDOWS,
    description:
      'The whole week. Windows of one weekday may touch, never overlap (OFFICE_HOURS_OVERLAP). An empty list closes the office.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_WINDOWS, withParams({ min: 0, max: MAX_WINDOWS }))
  @ValidateNested({ each: true })
  @Type(() => OfficeWindowDto)
  windows: OfficeWindowDto[];
}
