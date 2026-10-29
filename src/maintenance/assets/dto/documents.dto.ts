import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  DOCUMENT_KINDS,
  DOCUMENT_TITLE,
  type DocumentKind,
} from '../asset-rules';

/** Exactly one of the four. */
export class DocumentSubjectDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetTypeId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A maintenance contract (ADR 0065).',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string;
}

export class AddDocumentDto extends DocumentSubjectDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'One of the caller’s finalized `asset_document` files.',
  })
  @IsUUID()
  fileId: string;

  @ApiProperty({ enum: DOCUMENT_KINDS })
  @IsIn(DOCUMENT_KINDS, withParams({ allowed: [...DOCUMENT_KINDS] }))
  kind: DocumentKind;

  @ApiProperty({
    type: String,
    minLength: DOCUMENT_TITLE.min,
    maxLength: DOCUMENT_TITLE.max,
  })
  @IsString()
  @Length(DOCUMENT_TITLE.min, DOCUMENT_TITLE.max, withParams(DOCUMENT_TITLE))
  title: string;
}
