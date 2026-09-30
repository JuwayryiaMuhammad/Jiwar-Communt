import { ApiProperty } from '@nestjs/swagger';
import { IdDocumentType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { withParams } from '../validation/validation-errors';

/**
 * A national ID or a passport (ADR 0018). Only shapes here; the document is
 * validated as a whole by parseIdentityDocument in the service, which
 * returns the same field codes.
 */
export class IdentityDocumentDto {
  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  @IsEnum(
    IdDocumentType,
    withParams({ allowed: Object.values(IdDocumentType) }),
  )
  idDocumentType: IdDocumentType;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 40,
    description: '14-digit national ID, or a passport number.',
  })
  @IsString()
  @Length(1, 40, withParams({ min: 1, max: 40 }))
  idDocumentNumber: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'ISO 3166-1 alpha-2; required for a passport.',
  })
  @IsOptional()
  @IsString()
  nationality?: string;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    description: 'Required for a passport, ignored for a national ID.',
  })
  @IsOptional()
  @IsString()
  birthDate?: string;
}
