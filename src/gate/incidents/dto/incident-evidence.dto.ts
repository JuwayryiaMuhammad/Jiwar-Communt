import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const KINDS = ['visitor_photo'] as const;

export class LinkEvidenceDto {
  @ApiProperty({
    enum: KINDS,
    enumName: 'IncidentEvidenceKind',
    description: '`visitor_photo`: the guard’s photo of a visitor at an entry.',
  })
  @IsIn(KINDS, withParams({ allowed: [...KINDS] }))
  kind: (typeof KINDS)[number];

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The entry whose photo the incident keeps.',
  })
  @IsUUID()
  entryId: string;
}
