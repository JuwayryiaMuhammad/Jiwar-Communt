import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';
import { COMPOUND_DOCUMENT_KINDS } from '../compound-documents.service';

/** Which document's versions. */
export class CompoundDocumentVersionsQueryDto {
  @ApiProperty({ enum: COMPOUND_DOCUMENT_KINDS })
  @IsIn(
    [...COMPOUND_DOCUMENT_KINDS],
    withParams({ allowed: [...COMPOUND_DOCUMENT_KINDS] }),
  )
  kind: string;
}

/** A new version of one of the compound's documents (ADR 0062). */
export class NewCompoundDocumentVersionDto extends CompoundDocumentVersionsQueryDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  titleEn: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  titleAr: string;

  @ApiProperty({ type: String, maxLength: 50000, description: 'Markdown.' })
  @IsString()
  @Length(1, 50000, withParams({ min: 1, max: 50000 }))
  bodyEn: string;

  @ApiProperty({ type: String, maxLength: 50000, description: 'Markdown.' })
  @IsString()
  @Length(1, 50000, withParams({ min: 1, max: 50000 }))
  bodyAr: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: 5000,
    description:
      'What this version changes: required from the second version on, refused on the first.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 5000, withParams({ min: 1, max: 5000 }))
  changesEn?: string;

  @ApiProperty({ type: String, required: false, maxLength: 5000 })
  @IsOptional()
  @IsString()
  @Length(1, 5000, withParams({ min: 1, max: 5000 }))
  changesAr?: string;

  @ApiProperty({ type: String, format: 'date' })
  @IsLocalDate(withParams({ format: 'YYYY-MM-DD' }))
  effectiveOn: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'A finalized `compound_document` PDF of the caller’s: the signed copy.',
  })
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'The bylaws only, and required there: the board’s published decision that adopted this version.',
  })
  @IsOptional()
  @IsUUID()
  boardPublicationId?: string;
}
