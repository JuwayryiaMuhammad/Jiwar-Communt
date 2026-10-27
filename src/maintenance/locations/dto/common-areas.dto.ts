import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  AREA_CODE,
  AREA_NAME,
  BUILDING_NAME,
  COMMON_AREA_KINDS,
  LATITUDE,
  LONGITUDE,
  type CommonAreaKind,
} from '../area-rules';

const KINDS = withParams({ allowed: [...COMMON_AREA_KINDS] });
const decimals = { maxDecimalPlaces: 6 };
const BOOL = ['true', 'false'] as const;

export class CreateCommonAreaDto {
  @ApiProperty({
    enum: COMMON_AREA_KINDS,
    description:
      '`building`: a building as a whole (`building` required: the units’ building). `area`: any other place (`building` optional). `facility`: one of the facilities (`facilityId` required).',
  })
  @IsIn(COMMON_AREA_KINDS, KINDS)
  kind: CommonAreaKind;

  @ApiProperty({
    type: String,
    pattern: AREA_CODE.source,
    description: 'The compound’s short code, unique. Never changes.',
  })
  @IsString()
  @Matches(AREA_CODE)
  code: string;

  @ApiProperty({
    type: String,
    minLength: AREA_NAME.min,
    maxLength: AREA_NAME.max,
  })
  @IsString()
  @Length(AREA_NAME.min, AREA_NAME.max, withParams(AREA_NAME))
  nameAr: string;

  @ApiProperty({
    type: String,
    minLength: AREA_NAME.min,
    maxLength: AREA_NAME.max,
  })
  @IsString()
  @Length(AREA_NAME.min, AREA_NAME.max, withParams(AREA_NAME))
  nameEn: string;

  @ApiPropertyOptional({
    type: String,
    minLength: BUILDING_NAME.min,
    maxLength: BUILDING_NAME.max,
    description: 'As the units have it: some unit must be in it.',
  })
  @IsOptional()
  @IsString()
  @Length(BUILDING_NAME.min, BUILDING_NAME.max, withParams(BUILDING_NAME))
  building?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  facilityId?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: LATITUDE.min,
    maximum: LATITUDE.max,
  })
  @IsOptional()
  @IsNumber(decimals, withParams({ ...LATITUDE }))
  @Min(LATITUDE.min, withParams({ ...LATITUDE }))
  @Max(LATITUDE.max, withParams({ ...LATITUDE }))
  latitude?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: LONGITUDE.min,
    maximum: LONGITUDE.max,
  })
  @IsOptional()
  @IsNumber(decimals, withParams({ ...LONGITUDE }))
  @Min(LONGITUDE.min, withParams({ ...LONGITUDE }))
  @Max(LONGITUDE.max, withParams({ ...LONGITUDE }))
  longitude?: number;
}

export class UpdateCommonAreaDto {
  @ApiPropertyOptional({
    type: String,
    minLength: AREA_NAME.min,
    maxLength: AREA_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(AREA_NAME.min, AREA_NAME.max, withParams(AREA_NAME))
  nameAr?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: AREA_NAME.min,
    maxLength: AREA_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(AREA_NAME.min, AREA_NAME.max, withParams(AREA_NAME))
  nameEn?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: BUILDING_NAME.min,
    maxLength: BUILDING_NAME.max,
    description:
      'An area’s building; null clears it. A building’s own never changes.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(BUILDING_NAME.min, BUILDING_NAME.max, withParams(BUILDING_NAME))
  building?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: LATITUDE.min,
    maximum: LATITUDE.max,
    description: 'With `longitude`; both null clear the position.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber(decimals, withParams({ ...LATITUDE }))
  @Min(LATITUDE.min, withParams({ ...LATITUDE }))
  @Max(LATITUDE.max, withParams({ ...LATITUDE }))
  latitude?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: LONGITUDE.min,
    maximum: LONGITUDE.max,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber(decimals, withParams({ ...LONGITUDE }))
  @Min(LONGITUDE.min, withParams({ ...LONGITUDE }))
  @Max(LONGITUDE.max, withParams({ ...LONGITUDE }))
  longitude?: number | null;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'False retires it: no new asset, plan or inspection there.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CommonAreasQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: COMMON_AREA_KINDS })
  @IsOptional()
  @IsIn(COMMON_AREA_KINDS, KINDS)
  kind?: CommonAreaKind;

  @ApiPropertyOptional({
    enum: BOOL,
    description: 'Only active ones (`true`) or only retired ones (`false`).',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  active?: (typeof BOOL)[number];
}
