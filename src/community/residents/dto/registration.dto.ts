import { ApiProperty } from '@nestjs/swagger';
import {
  IdDocumentType,
  Locale,
  OccupancyType,
  UnitType,
} from '@prisma/client';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

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
