import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PLACE_NAME, PLACE_POSITION } from '../default-places';

export class CreatePlaceDto {
  @ApiProperty({
    type: String,
    minLength: PLACE_NAME.min,
    maxLength: PLACE_NAME.max,
    example: 'Phase C',
  })
  @IsString()
  @Length(PLACE_NAME.min, PLACE_NAME.max, withParams(PLACE_NAME))
  nameEn: string;

  @ApiProperty({
    type: String,
    minLength: PLACE_NAME.min,
    maxLength: PLACE_NAME.max,
    example: 'المرحلة ج',
  })
  @IsString()
  @Length(PLACE_NAME.min, PLACE_NAME.max, withParams(PLACE_NAME))
  nameAr: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: PLACE_POSITION.min,
    maximum: PLACE_POSITION.max,
    description: 'Lower first; 0 by default.',
  })
  @IsOptional()
  @IsInt(withParams(PLACE_POSITION))
  @Min(PLACE_POSITION.min, withParams(PLACE_POSITION))
  @Max(PLACE_POSITION.max, withParams(PLACE_POSITION))
  position?: number;
}

export class UpdatePlaceDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: PLACE_NAME.min,
    maxLength: PLACE_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(PLACE_NAME.min, PLACE_NAME.max, withParams(PLACE_NAME))
  nameEn?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: PLACE_NAME.min,
    maxLength: PLACE_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(PLACE_NAME.min, PLACE_NAME.max, withParams(PLACE_NAME))
  nameAr?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: PLACE_POSITION.min,
    maximum: PLACE_POSITION.max,
  })
  @IsOptional()
  @IsInt(withParams(PLACE_POSITION))
  @Min(PLACE_POSITION.min, withParams(PLACE_POSITION))
  @Max(PLACE_POSITION.max, withParams(PLACE_POSITION))
  position?: number;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False retires the place: offered no more, kept by requests.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
