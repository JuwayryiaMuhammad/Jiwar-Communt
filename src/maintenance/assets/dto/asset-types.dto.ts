import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  ValidateIf,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { CATEGORY_KEY } from '../../categories/dto/categories.dto';
import { LIFE_YEARS } from '../asset-rules';

const NAME = { min: 1, max: 80 };

export class CreateAssetTypeDto {
  @ApiProperty({
    type: String,
    pattern: CATEGORY_KEY.source,
    description: 'Stable code, lowercase (e.g. `chiller`). Never changes.',
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
    description: 'An active category: its technicians work on these assets.',
  })
  @IsUUID()
  categoryId: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: LIFE_YEARS.min,
    maximum: LIFE_YEARS.max,
  })
  @IsOptional()
  @IsInt(withParams(LIFE_YEARS))
  @Min(LIFE_YEARS.min, withParams(LIFE_YEARS))
  @Max(LIFE_YEARS.max, withParams(LIFE_YEARS))
  expectedLifeYears?: number;
}

export class UpdateAssetTypeDto {
  @ApiPropertyOptional({
    type: String,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: LIFE_YEARS.min,
    maximum: LIFE_YEARS.max,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt(withParams(LIFE_YEARS))
  @Min(LIFE_YEARS.min, withParams(LIFE_YEARS))
  @Max(LIFE_YEARS.max, withParams(LIFE_YEARS))
  expectedLifeYears?: number | null;

  @ApiPropertyOptional({ type: Boolean, description: 'False retires it.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
