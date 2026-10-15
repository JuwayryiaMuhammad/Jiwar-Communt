import { ApiProperty } from '@nestjs/swagger';
import { GateServiceKind, GateServiceStatus } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  ETA_MINUTES,
  type EtaMinutes,
  type WhenCode,
} from '../../safety/safety-rules';
import { CLOSE_NOTE } from '../gate-service-handlers.service';
import { DESCRIPTION, NOTES } from '../gate-services.service';

const WHEN = REASON_CODES.gateServiceWhen;
const ASSISTANCE = REASON_CODES.assistanceKind;
const LANE = REASON_CODES.laneReason;

class UnitRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The caller’s unit: someone who lives there asks.',
  })
  @IsUUID()
  unitId: string;
}

export class CreateAccessibilityRequestDto extends UnitRequestDto {
  @ApiProperty({ enum: [...ASSISTANCE], enumName: 'AssistanceKind' })
  @IsIn(ASSISTANCE, withParams({ allowed: [...ASSISTANCE] }))
  assistanceKind: (typeof ASSISTANCE)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description:
      'A member of the unit’s household (an id of GET /units/{unitId}/household); absent or null: the caller.',
  })
  @IsOptional()
  @IsUUID()
  memberId?: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A place of GET /community/places.',
  })
  @IsUUID()
  fromPlaceId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description: 'A place; absent or null: to the unit.',
  })
  @IsOptional()
  @IsUUID()
  toPlaceId?: string | null;

  @ApiProperty({ enum: [...WHEN], enumName: 'GateServiceWhen' })
  @IsIn(WHEN, withParams({ allowed: [...WHEN] }))
  when: WhenCode;
}

export class CreateSecurityReportDto extends UnitRequestDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Where: a place of GET /community/places.',
  })
  @IsUUID()
  placeId: string;

  @ApiProperty({
    type: String,
    minLength: DESCRIPTION.min,
    maxLength: DESCRIPTION.max,
    example: 'A man trying car doors in the visitor parking',
  })
  @IsString()
  @Length(DESCRIPTION.min, DESCRIPTION.max, withParams({ ...DESCRIPTION }))
  description: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A finalized `gate_service_photo` upload of the caller.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

export class CreateEscortRequestDto extends UnitRequestDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'A place.' })
  @IsUUID()
  fromPlaceId: string;

  @ApiProperty({ type: String, format: 'uuid', description: 'A place.' })
  @IsUUID()
  toPlaceId: string;

  @ApiProperty({ enum: [...WHEN], enumName: 'GateServiceWhen' })
  @IsIn(WHEN, withParams({ allowed: [...WHEN] }))
  when: WhenCode;
}

export class CreateLaneRequestDto extends UnitRequestDto {
  @ApiProperty({ enum: [...LANE], enumName: 'LaneReason' })
  @IsIn(LANE, withParams({ allowed: [...LANE] }))
  reason: (typeof LANE)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A gate in service (GET /gates/status).',
  })
  @IsUUID()
  gateId: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: NOTES.min,
    maxLength: NOTES.max,
  })
  @IsOptional()
  @IsString()
  @Length(NOTES.min, NOTES.max, withParams({ ...NOTES }))
  notes?: string;
}

export class MyGateServicesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: GateServiceStatus,
    enumName: 'GateServiceStatus',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    GateServiceStatus,
    withParams({ allowed: Object.values(GateServiceStatus) }),
  )
  status?: GateServiceStatus;

  @ApiProperty({
    enum: GateServiceKind,
    enumName: 'GateServiceKind',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    GateServiceKind,
    withParams({ allowed: Object.values(GateServiceKind) }),
  )
  kind?: GateServiceKind;
}

export class AcceptGateServiceDto {
  @ApiProperty({
    enum: ETA_MINUTES,
    required: false,
    description:
      'The minutes you expect to take: required for accessibility help and an escort.',
  })
  @IsOptional()
  @IsIn(ETA_MINUTES, withParams({ allowed: [...ETA_MINUTES] }))
  etaMinutes?: EtaMinutes;
}

export class CloseGateServiceDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `gateServiceClose`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: CLOSE_NOTE.min,
    maxLength: CLOSE_NOTE.max,
    description: 'Security’s own words, kept for the management.',
  })
  @IsOptional()
  @IsString()
  @Length(CLOSE_NOTE.min, CLOSE_NOTE.max, withParams({ ...CLOSE_NOTE }))
  note?: string;
}

export class StaffGateServicesQueryDto extends MyGateServicesQueryDto {}
