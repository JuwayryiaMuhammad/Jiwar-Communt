import { ApiProperty } from '@nestjs/swagger';
import { MarketListingCategory, MarketListingKind } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
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
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  LISTING_BODY_LENGTH,
  LISTING_TITLE_LENGTH,
  MAX_LISTING_PHOTOS,
  PRICE,
} from '../market-rules';
import {
  MARKET_SETTING_RANGES,
  type MarketNumberSetting,
} from '../market-settings.service';

const KINDS = Object.values(MarketListingKind);
const CATEGORIES = Object.values(MarketListingCategory);
const SORTS = ['newest', 'price_asc', 'price_desc'] as const;
const QUEUE = ['pending_review', 'under_review'] as const;

export class CreateListingDto {
  @ApiProperty({
    enum: MarketListingKind,
    enumName: 'MarketListingKind',
    description:
      '`sell`, `give` (free), `wanted`, `service` (offered by a resident), `unit_sale` or `unit_rent` (an owned unit, by its owner).',
  })
  @IsEnum(MarketListingKind, withParams({ allowed: KINDS }))
  kind: MarketListingKind;

  @ApiProperty({
    enum: MarketListingCategory,
    enumName: 'MarketListingCategory',
    description:
      'A unit for sale or to let is `real_estate`; nothing else is (INVALID_VALUE).',
  })
  @IsEnum(MarketListingCategory, withParams({ allowed: CATEGORIES }))
  category: MarketListingCategory;

  @ApiProperty({
    type: String,
    minLength: LISTING_TITLE_LENGTH.min,
    maxLength: LISTING_TITLE_LENGTH.max,
  })
  @IsString()
  @Length(
    LISTING_TITLE_LENGTH.min,
    LISTING_TITLE_LENGTH.max,
    withParams({ ...LISTING_TITLE_LENGTH }),
  )
  title: string;

  @ApiProperty({
    type: String,
    minLength: LISTING_BODY_LENGTH.min,
    maxLength: LISTING_BODY_LENGTH.max,
    description: 'What it is, its condition, where to see it.',
  })
  @IsString()
  @Length(
    LISTING_BODY_LENGTH.min,
    LISTING_BODY_LENGTH.max,
    withParams({ ...LISTING_BODY_LENGTH }),
  )
  body: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: PRICE.source,
    example: '1500.00',
    description:
      'EGP. Required to sell and for a unit (FIELD_REQUIRED); refused on a gift (FIELD_NOT_ALLOWED).',
  })
  @IsOptional()
  @IsString()
  @Matches(PRICE)
  price?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Open to offers. Ignored without a price.',
  })
  @IsOptional()
  @IsBoolean()
  negotiable?: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'The unit for sale or to let: one the caller owns now (MARKET_UNIT_NOT_OWNED). Only for `unit_sale` and `unit_rent`.',
  })
  @IsOptional()
  @IsUUID('all')
  unitId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'One of the caller’s units to list from, when they have several: only its building shows. Not for a unit listing.',
  })
  @IsOptional()
  @IsUUID('all')
  fromUnitId?: string;

  @ApiProperty({
    type: [String],
    required: false,
    maxItems: MAX_LISTING_PHOTOS,
    description: `Up to ${MAX_LISTING_PHOTOS} uploaded files of purpose \`market_listing_photo\`, in the order shown.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    MAX_LISTING_PHOTOS,
    withParams({ min: 0, max: MAX_LISTING_PHOTOS }),
  )
  @IsUUID('all', { each: true })
  photoFileIds?: string[];
}

export class UpdateListingDto {
  @ApiProperty({
    enum: MarketListingCategory,
    enumName: 'MarketListingCategory',
    required: false,
  })
  @IsOptional()
  @IsEnum(MarketListingCategory, withParams({ allowed: CATEGORIES }))
  category?: MarketListingCategory;

  @ApiProperty({
    type: String,
    required: false,
    minLength: LISTING_TITLE_LENGTH.min,
    maxLength: LISTING_TITLE_LENGTH.max,
  })
  @IsOptional()
  @IsString()
  @Length(
    LISTING_TITLE_LENGTH.min,
    LISTING_TITLE_LENGTH.max,
    withParams({ ...LISTING_TITLE_LENGTH }),
  )
  title?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: LISTING_BODY_LENGTH.min,
    maxLength: LISTING_BODY_LENGTH.max,
  })
  @IsOptional()
  @IsString()
  @Length(
    LISTING_BODY_LENGTH.min,
    LISTING_BODY_LENGTH.max,
    withParams({ ...LISTING_BODY_LENGTH }),
  )
  body?: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    pattern: PRICE.source,
    description:
      '`null` takes the price off, where the kind allows none (FIELD_REQUIRED otherwise).',
  })
  @IsOptional()
  @ValidateIf((o: UpdateListingDto) => o.price !== null)
  @IsString()
  @Matches(PRICE)
  price?: string | null;

  @ApiProperty({ type: Boolean, required: false })
  @IsOptional()
  @IsBoolean()
  negotiable?: boolean;
}

export class MarketQueryDto extends PageQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    maxLength: 100,
    description:
      'Words to find in the title or the body. 30 searches a minute.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  q?: string;

  @ApiProperty({
    enum: MarketListingKind,
    enumName: 'MarketListingKind',
    required: false,
  })
  @IsOptional()
  @IsEnum(MarketListingKind, withParams({ allowed: KINDS }))
  kind?: MarketListingKind;

  @ApiProperty({
    enum: MarketListingCategory,
    enumName: 'MarketListingCategory',
    required: false,
  })
  @IsOptional()
  @IsEnum(MarketListingCategory, withParams({ allowed: CATEGORIES }))
  category?: MarketListingCategory;

  @ApiProperty({ type: String, required: false, pattern: PRICE.source })
  @IsOptional()
  @IsString()
  @Matches(PRICE)
  minPrice?: string;

  @ApiProperty({ type: String, required: false, pattern: PRICE.source })
  @IsOptional()
  @IsString()
  @Matches(PRICE)
  maxPrice?: string;

  @ApiProperty({
    enum: SORTS,
    required: false,
    default: 'newest',
    description: 'A price sort reads only listings with a price.',
  })
  @IsOptional()
  @IsIn(SORTS, withParams({ allowed: [...SORTS] }))
  sort?: (typeof SORTS)[number];
}

export class MarketQueueQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: QUEUE,
    required: false,
    description: 'Both when left out.',
  })
  @IsOptional()
  @IsIn(QUEUE, withParams({ allowed: [...QUEUE] }))
  status?: (typeof QUEUE)[number];
}

export class ListingReasonDto {
  @ApiProperty({
    type: String,
    description:
      'A code of the action’s list: `marketListingReject` to turn a listing down, `marketListingRemove` to take one off (INVALID_REASON_CODE names the allowed ones).',
  })
  @IsString()
  reasonCode: string;
}

/** One optional whole number inside its column's range. */
function Setting(name: MarketNumberSetting, description: string) {
  const { min, max } = MARKET_SETTING_RANGES[name];
  const params = withParams({ min, max });
  return (target: object, key: string) => {
    ApiProperty({
      type: Number,
      required: false,
      minimum: min,
      maximum: max,
      description,
    })(target, key);
    IsOptional()(target, key);
    IsInt(params)(target, key);
    Min(min, params)(target, key);
    Max(max, params)(target, key);
  };
}

export class UpdateMarketSettingsDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'A new or changed listing waits for a handler first.',
  })
  @IsOptional()
  @IsBoolean()
  requiresReview?: boolean;

  @Setting(
    'maxLivePerAccount',
    'Listings one account may have waiting, live or reported at once.',
  )
  maxLivePerAccount?: number;

  @Setting('expiryDays', 'Days a listing stays on the market.')
  expiryDays?: number;

  @Setting(
    'reportHideThreshold',
    'Units whose reports take a live listing off for review.',
  )
  reportHideThreshold?: number;
}
