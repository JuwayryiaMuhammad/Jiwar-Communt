import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { CATEGORY_KEY } from '../../categories/dto/categories.dto';

const NAME = { min: 1, max: 80 };
const POSITION = { min: 0, max: 1000 };

export class CreatePreventiveServiceDto {
  @ApiProperty({
    type: String,
    pattern: CATEGORY_KEY.source,
    description:
      'Stable code, lowercase (e.g. `water_heater`). Never changes once created.',
  })
  @IsString()
  @Matches(CATEGORY_KEY)
  key: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active category: its technicians do the check-up.',
  })
  @IsUUID()
  categoryId: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: POSITION.min,
    maximum: POSITION.max,
    description:
      'The order the residents see, lowest first; after the others when absent.',
  })
  @IsOptional()
  @IsInt(withParams(POSITION))
  @Min(POSITION.min, withParams(POSITION))
  @Max(POSITION.max, withParams(POSITION))
  position?: number;
}

export class UpdatePreventiveServiceDto {
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

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: POSITION.min,
    maximum: POSITION.max,
  })
  @IsOptional()
  @IsInt(withParams(POSITION))
  @Min(POSITION.min, withParams(POSITION))
  @Max(POSITION.max, withParams(POSITION))
  position?: number;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False retires it: no new request for it.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
