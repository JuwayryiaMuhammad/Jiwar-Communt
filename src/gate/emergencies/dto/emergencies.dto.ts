import { ApiProperty } from '@nestjs/swagger';
import { EmergencyType } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ETA_MINUTES, type EtaMinutes } from '../../safety/safety-rules';
import { CLOSE_NOTE } from '../emergency-responders.service';

export class ReportEmergencyDto {
  @ApiProperty({ enum: EmergencyType, enumName: 'EmergencyType' })
  @IsEnum(EmergencyType, withParams({ allowed: Object.values(EmergencyType) }))
  type: EmergencyType;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A unit that gives the caller the emergency button.',
  })
  @IsUUID()
  unitId: string;
}

export class RaiseSosDto {
  @ApiProperty({
    enum: EmergencyType,
    enumName: 'EmergencyType',
    description:
      'Raised from the post of your open shift, a gate or a zone (ADR 0053).',
  })
  @IsEnum(EmergencyType, withParams({ allowed: Object.values(EmergencyType) }))
  type: EmergencyType;
}

export class CancelEmergencyDto {
  @ApiProperty({
    type: String,
    required: false,
    description: 'From the closed list `emergencyCancel`; optional.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

const STATES = ['open', 'closed'] as const;

export class MyEmergenciesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: STATES,
    required: false,
    description:
      '`open`: reported, on the way or arrived; `closed`: resolved or cancelled.',
  })
  @IsOptional()
  @IsIn(STATES, withParams({ allowed: [...STATES] }))
  status?: (typeof STATES)[number];
}

export class AcceptEmergencyDto {
  @ApiProperty({
    enum: ETA_MINUTES,
    description:
      'How many minutes the responder expects to take: the household sees it count down.',
  })
  @IsIn(ETA_MINUTES, withParams({ allowed: [...ETA_MINUTES] }))
  etaMinutes: EtaMinutes;
}

export class ResolveEmergencyDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `emergencyResolve`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: CLOSE_NOTE.min,
    maxLength: CLOSE_NOTE.max,
    description: 'The staff’s own words, kept for the management.',
  })
  @IsOptional()
  @IsString()
  @Length(CLOSE_NOTE.min, CLOSE_NOTE.max, withParams({ ...CLOSE_NOTE }))
  note?: string;
}

export class StaffEmergenciesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: STATES,
    required: false,
    description: '`open` is the queue, oldest first; else newest first.',
  })
  @IsOptional()
  @IsIn(STATES, withParams({ allowed: [...STATES] }))
  status?: (typeof STATES)[number];
}
