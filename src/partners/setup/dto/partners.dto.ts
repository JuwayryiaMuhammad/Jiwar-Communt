import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  END_MINUTE,
  START_MINUTE,
  WEEKDAY,
} from '../../../core/common/slots/weekly-windows';
import { IsPhone } from '../../../core/common/validation/is-phone';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PARTNER_CATEGORIES, type PartnerCategory } from '../../categories';
import { PARTNER_PRICE_UNITS, type PartnerPriceUnit } from '../defaults';

export const PARTNER_NAME = { min: 1, max: 80 } as const;
export const PARTNER_DESCRIPTION = { min: 1, max: 1000 } as const;
export const BUILDING = { min: 1, max: 40 } as const;
export const MAX_BUILDINGS = 50;
export const MAX_SERVICES = 30;
export const MAX_WINDOWS = 28;
export const MAX_PRICE_ITEMS = 100;
/** EGP, two decimals at most, zero allowed (free delivery), below a million. */
export const PRICE = /^\d{1,6}(\.\d{1,2})?$/;

function Name(required: boolean) {
  return (target: object, key: string) => {
    ApiProperty({
      type: String,
      required,
      minLength: PARTNER_NAME.min,
      maxLength: PARTNER_NAME.max,
      description:
        'Both languages are required; surrounding spaces are trimmed.',
    })(target, key);
    if (!required) IsOptional()(target, key);
    IsString()(target, key);
    Length(
      PARTNER_NAME.min,
      PARTNER_NAME.max,
      withParams(PARTNER_NAME),
    )(target, key);
  };
}

function Description() {
  return (target: object, key: string) => {
    ApiProperty({
      type: String,
      required: false,
      nullable: true,
      minLength: PARTNER_DESCRIPTION.min,
      maxLength: PARTNER_DESCRIPTION.max,
      description: 'Optional, per language. On an update, null clears it.',
    })(target, key);
    IsOptional()(target, key);
    ValidateIf((_, v) => v !== null)(target, key);
    IsString()(target, key);
    Length(
      PARTNER_DESCRIPTION.min,
      PARTNER_DESCRIPTION.max,
      withParams(PARTNER_DESCRIPTION),
    )(target, key);
  };
}

function Buildings() {
  return (target: object, key: string) => {
    ApiProperty({
      type: [String],
      required: false,
      maxItems: MAX_BUILDINGS,
      description:
        'Buildings as `GET /community/buildings` lists them. Empty or absent: the whole compound.',
    })(target, key);
    IsOptional()(target, key);
    IsArray()(target, key);
    ArrayMaxSize(MAX_BUILDINGS, withParams({ min: 0, max: MAX_BUILDINGS }))(
      target,
      key,
    );
    IsString({ each: true })(target, key);
    Length(BUILDING.min, BUILDING.max, { each: true, ...withParams(BUILDING) })(
      target,
      key,
    );
  };
}

export class PartnerServiceDto {
  @ApiProperty({ enum: PARTNER_CATEGORIES, enumName: 'PartnerCategory' })
  @IsIn(PARTNER_CATEGORIES, withParams({ allowed: [...PARTNER_CATEGORIES] }))
  category: PartnerCategory;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description:
      'An active sub-category of the compound under that category (PARTNER_SUBCATEGORY_NOT_AVAILABLE). Absent or null: the category as a whole.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  subcategoryId?: string | null;
}

export class CreatePartnerDto {
  @Name(true)
  nameEn: string;

  @Name(true)
  nameAr: string;

  @Description()
  descriptionEn?: string | null;

  @Description()
  descriptionAr?: string | null;

  @ApiProperty({
    type: String,
    example: '+20225550100',
    description:
      'The business phone residents call, stored E.164. Never a person’s own number.',
  })
  @IsPhone()
  businessPhone: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    description:
      'Where a new request is told, with no resident data and no link. Staff only.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEmail()
  @Length(3, 254, withParams({ min: 3, max: 254 }))
  notifyEmail?: string | null;

  @Buildings()
  serviceBuildings?: string[];

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'It comes to the home. Default false.',
  })
  @IsOptional()
  @IsBoolean()
  homeVisit?: boolean;

  @ApiProperty({
    type: [PartnerServiceDto],
    minItems: 1,
    maxItems: MAX_SERVICES,
    description: 'What it does: at least one category.',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: MAX_SERVICES }))
  @ArrayMaxSize(MAX_SERVICES, withParams({ min: 1, max: MAX_SERVICES }))
  @ValidateNested({ each: true })
  @Type(() => PartnerServiceDto)
  services: PartnerServiceDto[];
}

export class UpdatePartnerDto {
  @Name(false)
  nameEn?: string;

  @Name(false)
  nameAr?: string;

  @Description()
  descriptionEn?: string | null;

  @Description()
  descriptionAr?: string | null;

  @ApiProperty({ type: String, required: false, example: '+20225550100' })
  @IsOptional()
  @IsPhone()
  businessPhone?: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    description: 'Null clears it.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsEmail()
  @Length(3, 254, withParams({ min: 3, max: 254 }))
  notifyEmail?: string | null;

  @Buildings()
  serviceBuildings?: string[];

  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  homeVisit?: boolean;
}

export class ReplacePartnerServicesDto {
  @ApiProperty({
    type: [PartnerServiceDto],
    minItems: 1,
    maxItems: MAX_SERVICES,
    description: 'The whole set; each pair once (DUPLICATE_VALUE).',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: MAX_SERVICES }))
  @ArrayMaxSize(MAX_SERVICES, withParams({ min: 1, max: MAX_SERVICES }))
  @ValidateNested({ each: true })
  @Type(() => PartnerServiceDto)
  services: PartnerServiceDto[];
}

export class PartnerWindowDto {
  @ApiProperty({
    type: Number,
    minimum: WEEKDAY.min,
    maximum: WEEKDAY.max,
    description: '0 is Sunday.',
  })
  @IsInt(withParams({ ...WEEKDAY }))
  @Min(WEEKDAY.min, withParams({ ...WEEKDAY }))
  @Max(WEEKDAY.max, withParams({ ...WEEKDAY }))
  weekday: number;

  @ApiProperty({
    type: Number,
    minimum: START_MINUTE.min,
    maximum: START_MINUTE.max,
    description: 'Minutes after local midnight, in the compound’s time zone.',
  })
  @IsInt(withParams({ ...START_MINUTE }))
  @Min(START_MINUTE.min, withParams({ ...START_MINUTE }))
  @Max(START_MINUTE.max, withParams({ ...START_MINUTE }))
  startMinute: number;

  @ApiProperty({
    type: Number,
    minimum: END_MINUTE.min,
    maximum: END_MINUTE.max,
  })
  @IsInt(withParams({ ...END_MINUTE }))
  @Min(END_MINUTE.min, withParams({ ...END_MINUTE }))
  @Max(END_MINUTE.max, withParams({ ...END_MINUTE }))
  endMinute: number;
}

export class ReplacePartnerHoursDto {
  @ApiProperty({
    type: [PartnerWindowDto],
    maxItems: MAX_WINDOWS,
    description:
      'The whole week. Windows of one weekday may touch, never overlap (WINDOW_OVERLAP). Open past midnight: a window to 1440 and the next day’s from 0. Empty: no hours (never open).',
  })
  @IsArray()
  @ArrayMaxSize(MAX_WINDOWS, withParams({ min: 0, max: MAX_WINDOWS }))
  @ValidateNested({ each: true })
  @Type(() => PartnerWindowDto)
  windows: PartnerWindowDto[];
}

export class PartnerPriceItemDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description:
      'One of the partner’s sub-categories (PARTNER_SERVICE_NOT_OFFERED), or none.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  subcategoryId?: string | null;

  @Name(true)
  nameEn: string;

  @Name(true)
  nameAr: string;

  @ApiProperty({
    type: String,
    pattern: PRICE.source,
    description: 'EGP, e.g. `150` or `150.50`; `0` for free.',
  })
  @IsString()
  @Matches(PRICE)
  price: string;

  @ApiProperty({ enum: PARTNER_PRICE_UNITS, enumName: 'PartnerPriceUnit' })
  @IsIn(PARTNER_PRICE_UNITS, withParams({ allowed: [...PARTNER_PRICE_UNITS] }))
  unit: PartnerPriceUnit;
}

export class ReplacePartnerPricesDto {
  @ApiProperty({
    type: [PartnerPriceItemDto],
    maxItems: MAX_PRICE_ITEMS,
    description:
      'The whole list, in order. Requests already made keep the lines they named.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_PRICE_ITEMS, withParams({ min: 0, max: MAX_PRICE_ITEMS }))
  @ValidateNested({ each: true })
  @Type(() => PartnerPriceItemDto)
  items: PartnerPriceItemDto[];
}
