import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PARTNER_CATEGORIES, type PartnerCategory } from '../../categories';

export const NOTE = { min: 1, max: 500 } as const;
export const QUANTITY = { min: 1, max: 99 } as const;
export const STAFF_COUNT = { min: 1, max: 5 } as const;
const MAX_ITEMS = 10;

export class PartnerRequestLineDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'One of the partner’s announced price lines now (PARTNER_PRICE_ITEM_NOT_AVAILABLE), once.',
  })
  @IsUUID()
  priceItemId: string;

  @ApiProperty({ type: Number, minimum: QUANTITY.min, maximum: QUANTITY.max })
  @IsInt(withParams(QUANTITY))
  @Min(QUANTITY.min, withParams(QUANTITY))
  @Max(QUANTITY.max, withParams(QUANTITY))
  quantity: number;
}

export class CreatePartnerRequestDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  partnerId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A unit the caller may invite visitors to (PARTNER_REQUEST_NOT_ALLOWED otherwise).',
  })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    enum: PARTNER_CATEGORIES,
    enumName: 'PartnerCategory',
    description:
      'One the partner offers; its consent `partner_share_<category>` granted at the current version (CONSENT_REQUIRED).',
  })
  @IsIn(PARTNER_CATEGORIES, withParams({ allowed: [...PARTNER_CATEGORIES] }))
  category: PartnerCategory;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    nullable: true,
    description:
      'An active sub-category of the category, offered by the partner or covered by its whole category.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  subcategoryId?: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      '15 minutes to 14 days from now (PARTNER_WINDOW_TOO_SOON / _TOO_FAR).',
  })
  @ToInstant()
  @IsDate()
  windowStartsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      '30 minutes to 8 hours after the start (PARTNER_WINDOW_LENGTH).',
  })
  @ToInstant()
  @IsDate()
  windowEndsAt: Date;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: NOTE.min,
    maxLength: NOTE.max,
    description:
      'For the partner, while the category’s consent holds. Never put a phone or anyone’s name here.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(NOTE.min, NOTE.max, withParams(NOTE))
  note?: string | null;

  @ApiProperty({
    type: [PartnerRequestLineDto],
    required: false,
    maxItems: MAX_ITEMS,
    description:
      'Announced price lines, copied with the request as they are now.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS, withParams({ min: 0, max: MAX_ITEMS }))
  @ValidateNested({ each: true })
  @Type(() => PartnerRequestLineDto)
  items?: PartnerRequestLineDto[];

  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Default true: once accepted, the partner’s staff get a one-time gate pass for the window, in the requester’s name.',
  })
  @IsOptional()
  @IsBoolean()
  gatePass?: boolean;
}

const STATES = ['live', 'closed'] as const;

export class MyPartnerRequestsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: STATES,
    required: false,
    description: '`live`: pending, proposed, accepted. `closed`: the rest.',
  })
  @IsOptional()
  @IsIn(STATES, withParams({ allowed: [...STATES] }))
  state?: 'live' | 'closed';
}

export class ResidentCancelPartnerRequestDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `partnerRequestResidentCancel`.',
  })
  @IsString()
  reasonCode: string;
}

// What the partner does, on its desk or through the relay.

export class AcceptPartnerRequestDto {
  @ApiProperty({
    type: Number,
    required: false,
    minimum: STAFF_COUNT.min,
    maximum: STAFF_COUNT.max,
    description:
      'How many of its staff come (the gate pass lets in as many). Default 1.',
  })
  @IsOptional()
  @IsInt(withParams(STAFF_COUNT))
  @Min(STAFF_COUNT.min, withParams(STAFF_COUNT))
  @Max(STAFF_COUNT.max, withParams(STAFF_COUNT))
  staffCount?: number;
}

export class DeclinePartnerRequestDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `partnerRequestDecline`.',
  })
  @IsString()
  reasonCode: string;
}

export class ProposePartnerRequestDto extends AcceptPartnerRequestDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: '15 minutes to 14 days from now.',
  })
  @ToInstant()
  @IsDate()
  windowStartsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: '30 minutes to 8 hours after the start.',
  })
  @ToInstant()
  @IsDate()
  windowEndsAt: Date;
}

export class PartnerCancelPartnerRequestDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `partnerRequestPartnerCancel`.',
  })
  @IsString()
  reasonCode: string;
}
