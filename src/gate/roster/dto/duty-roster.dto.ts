import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ToInstant } from '../../../core/common/validation/instant';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import { RosterRangeQueryDto, WeeklyScheduleDto } from './roster.dto';

/**
 * A technician's post (ADR 0078): a zone in service, or none for the whole
 * compound. A gate is refused (FIELD_NOT_ALLOWED).
 */
export class DutyPostDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A place in service; absent for the whole compound.',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Never for a technician: FIELD_NOT_ALLOWED.',
  })
  @IsOptional()
  @IsUUID()
  gateId?: string;
}

export class CreateDutyTemplateDto extends DutyPostDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active `tickets.work` holder (GUARD_NOT_ELIGIBLE).',
  })
  @IsUUID()
  technicianId: string;

  @ApiProperty({
    type: WeeklyScheduleDto,
    description:
      'The weekly shifts: never overlapping the technician’s other templates or slots (409 ROSTER_OVERLAP).',
  })
  @ValidateNested()
  @Type(() => WeeklyScheduleDto)
  schedule: WeeklyScheduleDto;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Its first day, `YYYY-MM-DD`: today or later.',
  })
  @IsString()
  @IsLocalDate()
  effectiveFrom: string;

  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Its last day, inclusive. Absent for no end.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  effectiveUntil?: string;
}

export class CreateDutySlotDto extends DutyPostDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active `tickets.work` holder (GUARD_NOT_ELIGIBLE).',
  })
  @IsUUID()
  technicianId: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'In the future.',
  })
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'After the start, a day at most.',
  })
  @ToInstant()
  @IsDate()
  endsAt: Date;
}

export class DutySlotsQueryDto extends RosterRangeQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  technicianId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({ enum: ['scheduled', 'cancelled'] })
  @IsOptional()
  @IsIn(['scheduled', 'cancelled'])
  status?: 'scheduled' | 'cancelled';
}

export class DutyTemplatesQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  technicianId?: string;

  @ApiPropertyOptional({
    enum: ['live', 'ended'],
    description: 'Default: both.',
  })
  @IsOptional()
  @IsIn(['live', 'ended'])
  state?: 'live' | 'ended';
}

export class TechnicianAttendanceQueryDto extends RosterRangeQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  technicianId?: string;
}
