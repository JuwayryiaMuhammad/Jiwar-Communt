import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PARTNER_CATEGORIES, type PartnerCategory } from '../../categories';

export const SUBCATEGORY_NAME = { min: 1, max: 80 } as const;
export const SUBCATEGORY_POSITION = { min: 0, max: 1000 } as const;

export class CreatePartnerSubcategoryDto {
  @ApiProperty({
    enum: PARTNER_CATEGORIES,
    enumName: 'PartnerCategory',
    description: 'One of the closed list; never changes.',
  })
  @IsIn(PARTNER_CATEGORIES, withParams({ allowed: [...PARTNER_CATEGORIES] }))
  category: PartnerCategory;

  @ApiProperty({
    type: String,
    pattern: '^[a-z][a-z0-9_]{1,39}$',
    description: 'Unique in the compound (DUPLICATE_RESOURCE); never changes.',
  })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,39}$/)
  key: string;

  @ApiProperty({
    type: String,
    minLength: SUBCATEGORY_NAME.min,
    maxLength: SUBCATEGORY_NAME.max,
  })
  @IsString()
  @Length(
    SUBCATEGORY_NAME.min,
    SUBCATEGORY_NAME.max,
    withParams(SUBCATEGORY_NAME),
  )
  nameEn: string;

  @ApiProperty({
    type: String,
    minLength: SUBCATEGORY_NAME.min,
    maxLength: SUBCATEGORY_NAME.max,
  })
  @IsString()
  @Length(
    SUBCATEGORY_NAME.min,
    SUBCATEGORY_NAME.max,
    withParams(SUBCATEGORY_NAME),
  )
  nameAr: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: SUBCATEGORY_POSITION.min,
    maximum: SUBCATEGORY_POSITION.max,
    description: 'Order within its category. Default 0.',
  })
  @IsOptional()
  @IsInt(withParams(SUBCATEGORY_POSITION))
  @Min(SUBCATEGORY_POSITION.min, withParams(SUBCATEGORY_POSITION))
  @Max(SUBCATEGORY_POSITION.max, withParams(SUBCATEGORY_POSITION))
  position?: number;
}

export class UpdatePartnerSubcategoryDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: SUBCATEGORY_NAME.min,
    maxLength: SUBCATEGORY_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(
    SUBCATEGORY_NAME.min,
    SUBCATEGORY_NAME.max,
    withParams(SUBCATEGORY_NAME),
  )
  nameEn?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: SUBCATEGORY_NAME.min,
    maxLength: SUBCATEGORY_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(
    SUBCATEGORY_NAME.min,
    SUBCATEGORY_NAME.max,
    withParams(SUBCATEGORY_NAME),
  )
  nameAr?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: SUBCATEGORY_POSITION.min,
    maximum: SUBCATEGORY_POSITION.max,
  })
  @IsOptional()
  @IsInt(withParams(SUBCATEGORY_POSITION))
  @Min(SUBCATEGORY_POSITION.min, withParams(SUBCATEGORY_POSITION))
  @Max(SUBCATEGORY_POSITION.max, withParams(SUBCATEGORY_POSITION))
  position?: number;

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'False retires it: offered for nothing new; the partners that name it keep it.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
