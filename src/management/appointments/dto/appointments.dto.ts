import { ApiProperty } from '@nestjs/swagger';
import {
  ManagementAppointmentMode,
  ManagementAppointmentStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { SLOT_DAYS } from '../appointment-slots';

/** Which days to offer slots for. */
export class AppointmentSlotsQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    example: '2026-10-18',
    description:
      'The first day, `YYYY-MM-DD` in the compound’s time zone; today by default.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, withParams({ format: 'YYYY-MM-DD' }))
  from?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: SLOT_DAYS.min,
    maximum: SLOT_DAYS.max,
    default: 7,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt(withParams(SLOT_DAYS))
  @Min(SLOT_DAYS.min, withParams(SLOT_DAYS))
  @Max(SLOT_DAYS.max, withParams(SLOT_DAYS))
  days?: number;
}

/** A slot and how to meet. */
export class SlotChoiceDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'The start of one of the offered slots, exactly (APPOINTMENT_SLOT_NOT_OFFERED); at least an hour and at most thirty days from now.',
  })
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    enum: ManagementAppointmentMode,
    enumName: 'ManagementAppointmentMode',
  })
  @IsEnum(
    ManagementAppointmentMode,
    withParams({ allowed: Object.values(ManagementAppointmentMode) }),
  )
  mode: ManagementAppointmentMode;
}

export class CancelAppointmentByResidentDto {
  @ApiProperty({
    type: String,
    description:
      'From the closed list `managementAppointmentCancelByResident`.',
  })
  @IsString()
  reasonCode: string;
}

export class CancelAppointmentByStaffDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `managementAppointmentCancelByStaff`.',
  })
  @IsString()
  reasonCode: string;
}

export class StaffAppointmentsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: ManagementAppointmentStatus,
    enumName: 'ManagementAppointmentStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    ManagementAppointmentStatus,
    withParams({ allowed: Object.values(ManagementAppointmentStatus) }),
  )
  status?: ManagementAppointmentStatus;

  @ApiProperty({
    enum: ['true', 'false'],
    required: false,
    description:
      '`true`: only appointments that hold a slot (requested, proposed or confirmed).',
  })
  @IsOptional()
  @IsIn(['true', 'false'], withParams({ allowed: ['true', 'false'] }))
  live?: 'true' | 'false';

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'Starting at or after.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'Starting before.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
