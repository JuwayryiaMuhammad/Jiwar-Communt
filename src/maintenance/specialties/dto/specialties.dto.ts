import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const NAME = { min: 1, max: 80 };
export const SPECIALTY_KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** A set of specialties for one category or one technician. */
export const MAX_SPECIALTIES = 50;

export class CreateSpecialtyDto {
  @ApiProperty({
    type: String,
    pattern: SPECIALTY_KEY.source,
    description:
      'Stable code, lowercase (e.g. `hvac`). Never changes once created.',
  })
  @IsString()
  @Matches(SPECIALTY_KEY)
  key: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn: string;
}

export class UpdateSpecialtyDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'False retires it: it counts for no category and no technician.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class SpecialtyIdsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: MAX_SPECIALTIES,
    description:
      'The whole set, replacing the current one; empty clears it. Active specialties of the compound only.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_SPECIALTIES, withParams({ max: MAX_SPECIALTIES }))
  @ArrayUnique()
  @IsUUID('all', { each: true })
  specialtyIds: string[];
}
