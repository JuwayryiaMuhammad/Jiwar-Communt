import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const NAME = { min: 1, max: 80 };
export const COMPLAINT_CATEGORY_KEY = /^[a-z][a-z0-9_]{1,39}$/;

export class CreateComplaintCategoryDto {
  @ApiProperty({
    type: String,
    pattern: COMPLAINT_CATEGORY_KEY.source,
    description:
      'Stable code, lowercase (e.g. `noise`). Never changes once created.',
  })
  @IsString()
  @Matches(COMPLAINT_CATEGORY_KEY)
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

export class UpdateComplaintCategoryDto {
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
    description: 'False retires the category: no new complaint may use it.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
