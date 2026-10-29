import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  ADDABLE_KINDS,
  UNIT_DOCUMENT_VISIBILITIES,
} from '../unit-documents.service';

/** A finalized `unit_document` file of the caller's, filed in the vault (ADR 0062). */
export class NewUnitDocumentDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  fileId: string;

  @ApiProperty({ enum: ADDABLE_KINDS })
  @IsIn([...ADDABLE_KINDS], withParams({ allowed: [...ADDABLE_KINDS] }))
  kind: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120, withParams({ min: 1, max: 120 }))
  title: string;

  @ApiProperty({
    enum: UNIT_DOCUMENT_VISIBILITIES,
    description:
      '`private`: your occupancy only; `owners`: the unit’s owners; `occupants`: everyone living there. A delegate and the management never file a private one.',
  })
  @IsIn(
    [...UNIT_DOCUMENT_VISIBILITIES],
    withParams({ allowed: [...UNIT_DOCUMENT_VISIBILITIES] }),
  )
  visibility: string;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description:
      'A warranty’s end date: required for a warranty, refused otherwise.',
  })
  @IsOptional()
  @IsLocalDate(withParams({ format: 'YYYY-MM-DD' }))
  expiresOn?: string;
}
