import { ApiProperty } from '@nestjs/swagger';
import {
  IdDocumentType,
  Locale,
  OccupancyType,
  UnitType,
} from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IMAGE_TYPES } from '../../../core/files/purposes';
import {
  REGISTRATION_DOCUMENT_KINDS,
  type RegistrationDocumentKind,
} from '../registration-documents.service';

/**
 * What a registrant sends (ADR 0024). Only JSON types are checked here: the
 * service validates the content as a whole (the same field codes, all at
 * once, identical for every compound), so the answer never depends on
 * which check ran first.
 */
export class RegistrationRequestDto {
  @ApiProperty({
    type: String,
    description: "The compound's registration link token.",
  })
  @IsOptional()
  @IsString()
  linkToken: string;

  @ApiProperty({ type: String, minLength: 2, maxLength: 200 })
  @IsOptional()
  @IsString()
  fullName: string;

  @ApiProperty({
    type: String,
    maxLength: 50,
    description: 'As the registrant knows it.',
  })
  @IsOptional()
  @IsString()
  unitCode: string;

  @ApiProperty({ type: String })
  @IsOptional()
  @IsString()
  phone: string;

  @ApiProperty({
    type: String,
    format: 'email',
    description: 'The code goes here.',
  })
  @IsOptional()
  @IsString()
  email: string;

  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  @IsOptional()
  @IsString()
  idDocumentType: IdDocumentType;

  @ApiProperty({ type: String })
  @IsOptional()
  @IsString()
  idDocumentNumber: string;

  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  nationality?: string;

  @ApiProperty({ type: String, format: 'date', required: false })
  @IsOptional()
  @IsString()
  birthDate?: string;

  @ApiProperty({ enum: OccupancyType, enumName: 'OccupancyType' })
  @IsOptional()
  @IsString()
  occupancyType: OccupancyType;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Owners only: false = they let the unit.',
  })
  @IsOptional()
  @IsBoolean()
  resides?: boolean;

  @ApiProperty({ enum: Locale, enumName: 'Locale', required: false })
  @IsOptional()
  @IsString()
  preferredLocale?: Locale;

  @ApiProperty({ enum: UnitType, enumName: 'UnitType', required: false })
  @IsOptional()
  @IsString()
  unitType?: UnitType;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    required: false,
    example: '120.5',
    description: 'Square metres, up to 2 decimals (checked by the service).',
  })
  @IsOptional()
  areaSqm?: string | number;

  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  building?: string;
}

export class CompleteRegistrationDto extends RegistrationRequestDto {
  @ApiProperty({ type: String, pattern: '^\\\\d{6}$' })
  @Matches(/^\d{6}$/, withParams({ length: 6 }))
  code: string;
}

export class ApproveRegistrationDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'Corrects a mistyped unit.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      "Adds the unit to the same person's existing resident account (same phone AND email).",
  })
  @IsOptional()
  @IsBoolean()
  linkToExistingAccount?: boolean;
}

// ----------------------------------------------------------------------------
// The status link (ADR 0062)
// ----------------------------------------------------------------------------

const STATUS_TOKEN = {
  type: String,
  description:
    'The fragment of the status link (`/rs#<token>`). Anything that is not a live link answers 404 REGISTRATION_STATUS_NOT_FOUND.',
} as const;

/** The token from the status link's fragment, sent in the body. */
export class RegistrationStatusTokenDto {
  @ApiProperty(STATUS_TOKEN)
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}

export class RegistrationUploadDto extends RegistrationStatusTokenDto {
  @ApiProperty({ enum: REGISTRATION_DOCUMENT_KINDS })
  @IsIn(
    [...REGISTRATION_DOCUMENT_KINDS],
    withParams({ allowed: [...REGISTRATION_DOCUMENT_KINDS] }),
  )
  kind: RegistrationDocumentKind;

  @ApiProperty({
    type: String,
    enum: [...IMAGE_TYPES, 'application/pdf'],
    description: 'Signed into the upload (FILE_TYPE_NOT_ALLOWED otherwise).',
  })
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  contentType: string;

  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 10 * 1024 * 1024,
    description:
      'Bytes, signed into the upload; 10 MB at most (FILE_TOO_LARGE).',
  })
  @IsInt(withParams({ min: 1 }))
  @Min(1, withParams({ min: 1 }))
  size: number;
}

/** What the management asks the registrant to correct: codes only. */
export class RegistrationCorrectionDto {
  @ApiProperty({
    enum: REASON_CODES.registrationCorrection,
    isArray: true,
    minItems: 1,
    maxItems: 4,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1 }))
  @ArrayMaxSize(4, withParams({ max: 4 }))
  @IsString({ each: true })
  codes: string[];
}

export class PendingRegistrationsQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    enum: ['pending', 'needs_correction'],
    description:
      '`pending` (the default): waiting for the management; `needs_correction`: sent back, waiting for the registrant.',
  })
  @IsOptional()
  @IsIn(
    ['pending', 'needs_correction'],
    withParams({ allowed: ['pending', 'needs_correction'] }),
  )
  status?: 'pending' | 'needs_correction';
}
