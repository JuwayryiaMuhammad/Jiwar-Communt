import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

export const EVIDENCE_KINDS = ['visitor_photo', 'patrol_track'] as const;
const KINDS = EVIDENCE_KINDS;

export class LinkEvidenceDto {
  @ApiProperty({
    enum: KINDS,
    enumName: 'IncidentEvidenceKind',
    description:
      '`visitor_photo`: the guard’s photo of a visitor at an entry (`entryId`). `patrol_track`: where a patrol’s guard walked (`runId`), kept past its 30 days.',
  })
  @IsIn(KINDS, withParams({ allowed: [...KINDS] }))
  kind: (typeof KINDS)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'For `visitor_photo`: the entry whose photo the incident keeps (FIELD_REQUIRED; FIELD_NOT_ALLOWED otherwise).',
  })
  @IsOptional()
  @IsUUID()
  entryId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'For `patrol_track`: the run whose track the incident keeps — a guard, their own runs only (FIELD_REQUIRED; FIELD_NOT_ALLOWED otherwise).',
  })
  @IsOptional()
  @IsUUID()
  runId?: string;
}
