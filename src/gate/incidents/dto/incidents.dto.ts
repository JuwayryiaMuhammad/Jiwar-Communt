import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
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
  DESCRIPTION,
  MAX_INCIDENT_MEDIA,
  MAX_INCIDENT_PHOTOS,
  NOTE,
} from '../incidents.service';

const TYPES = REASON_CODES.incidentType;
const SEVERITIES = REASON_CODES.incidentSeverity;
const STATUSES = ['open', 'investigating', 'closed'] as const;
const ROLES = ['author', 'reviewer'] as const;

export class ReportIncidentDto {
  @ApiProperty({ enum: TYPES, enumName: 'IncidentType' })
  @IsIn(TYPES, withParams({ allowed: [...TYPES] }))
  type: (typeof TYPES)[number];

  @ApiProperty({
    enum: SEVERITIES,
    enumName: 'IncidentSeverity',
    description: '`critical` is a critical push to the incidents’ keepers.',
  })
  @IsIn(SEVERITIES, withParams({ allowed: [...SEVERITIES] }))
  severity: (typeof SEVERITIES)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A place in service (`GET /community/places`); and/or a unit.',
  })
  @IsOptional()
  @IsUUID()
  placeId?: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'A unit’s code; and/or a place.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'At most 30 days back, not more than 5 minutes ahead.',
  })
  @Type(() => Date)
  @IsDate()
  occurredAt: Date;

  @ApiProperty({
    type: String,
    minLength: DESCRIPTION.min,
    maxLength: DESCRIPTION.max,
    description:
      'What happened, in the author’s words. Never a resident’s to read.',
  })
  @IsString()
  @Length(DESCRIPTION.min, DESCRIPTION.max, withParams({ ...DESCRIPTION }))
  description: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    maxItems: MAX_INCIDENT_PHOTOS,
    description: 'Up to five `incident_photo` uploads of the caller’s.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_INCIDENT_PHOTOS, withParams({ max: MAX_INCIDENT_PHOTOS }))
  @IsUUID('all', { each: true })
  photoFileIds?: string[];

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    maxItems: MAX_INCIDENT_MEDIA,
    description:
      'Up to three recordings of the caller’s (ADR 0056): `incident_audio` (audio/mp4) or `incident_video` (video/mp4, video/quicktime), within the gate’s seconds and megabytes (MEDIA_TOO_LONG, FILE_TOO_LARGE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_INCIDENT_MEDIA, withParams({ max: MAX_INCIDENT_MEDIA }))
  @IsUUID('all', { each: true })
  mediaFileIds?: string[];

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  emergencyId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  gateServiceRequestId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  patrolNoteId?: string;
}

export class StaffIncidentsQueryDto extends PageQueryDto {
  @ApiProperty({ enum: STATUSES, required: false })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];

  @ApiProperty({ enum: TYPES, required: false })
  @IsOptional()
  @IsIn(TYPES, withParams({ allowed: [...TYPES] }))
  type?: (typeof TYPES)[number];

  @ApiProperty({ enum: SEVERITIES, required: false })
  @IsOptional()
  @IsIn(SEVERITIES, withParams({ allowed: [...SEVERITIES] }))
  severity?: (typeof SEVERITIES)[number];

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'Happened at or after.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description: 'Happened before.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class AssignIncidentDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active holder of `incidents.manage`.',
  })
  @IsUUID()
  investigatorId: string;
}

export class IncidentNoteDto {
  @ApiProperty({ type: String, minLength: NOTE.min, maxLength: NOTE.max })
  @IsString()
  @Length(NOTE.min, NOTE.max, withParams({ ...NOTE }))
  body: string;
}

export class CloseIncidentDto {
  @ApiProperty({
    type: String,
    description: 'The outcome, from the closed list `incidentOutcome`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    minLength: NOTE.min,
    maxLength: NOTE.max,
    description: 'The closer’s own words, the management’s only.',
  })
  @IsString()
  @Length(NOTE.min, NOTE.max, withParams({ ...NOTE }))
  note: string;
}

export class AcknowledgeIncidentDto {
  @ApiProperty({
    enum: ROLES,
    description:
      '`author`: the one who reported it; `reviewer`: a keeper who did not (INCIDENT_OWN otherwise).',
  })
  @IsIn(ROLES, withParams({ allowed: [...ROLES] }))
  role: (typeof ROLES)[number];
}
