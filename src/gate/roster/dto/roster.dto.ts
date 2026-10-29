import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { REASON_CODES } from '../../../core/common/reasons';
import { ToInstant } from '../../../core/common/validation/instant';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';

class WeeklyWindowDto {
  @ApiProperty({ type: String, example: '22:00' })
  @IsString()
  from: string;

  @ApiProperty({
    type: String,
    example: '06:00',
    description: 'Before `from`: the window runs into the next day.',
  })
  @IsString()
  to: string;
}

export class WeeklyScheduleDto {
  @ApiProperty({
    type: [Number],
    description: 'Weekdays, 0 = Sunday … 6 = Saturday.',
  })
  @IsArray()
  @IsInt({ each: true })
  days: number[];

  @ApiProperty({ type: [WeeklyWindowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowDto)
  windows: WeeklyWindowDto[];
}

/** A gate or a zone (one of the compound's places), exactly one. */
export class PostDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A place in service, for a post that is not a gate.',
  })
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}

export class CreateRosterTemplateDto extends PostDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active `gate.operate` holder (GUARD_NOT_ELIGIBLE).',
  })
  @IsUUID()
  guardId: string;

  @ApiProperty({
    type: WeeklyScheduleDto,
    description:
      'The weekly shifts: never overlapping the guard’s other templates or slots (409 ROSTER_OVERLAP).',
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

export class CreateRosterSlotDto extends PostDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active `gate.operate` holder (GUARD_NOT_ELIGIBLE).',
  })
  @IsUUID()
  guardId: string;

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

export class CancelRosterSlotDto {
  @ApiProperty({
    enum: [...REASON_CODES.guardSlotCancel],
    enumName: 'GuardSlotCancel',
  })
  @IsString()
  reasonCode: string;
}

/** The compound's days `from` … `to`, inclusive: 31 at most. */
export class RosterRangeQueryDto {
  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The first day, `YYYY-MM-DD`. Default today.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The last day, inclusive. Default 13 days after `from`.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}

export class RosterSlotsQueryDto extends RosterRangeQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  guardId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gateId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  @ApiPropertyOptional({ enum: ['scheduled', 'cancelled'] })
  @IsOptional()
  @IsIn(['scheduled', 'cancelled'])
  status?: 'scheduled' | 'cancelled';
}

export class RosterTemplatesQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  guardId?: string;

  @ApiPropertyOptional({
    enum: ['live', 'ended'],
    description: 'Default: both.',
  })
  @IsOptional()
  @IsIn(['live', 'ended'])
  state?: 'live' | 'ended';
}

export class GuardAttendanceQueryDto extends RosterRangeQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  guardId?: string;
}
