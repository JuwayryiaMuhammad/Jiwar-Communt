import { ApiProperty } from '@nestjs/swagger';
import {
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  GROUP_BODY_LENGTH,
  GROUP_TITLE_LENGTH,
  MAX_QUANTITY,
  RECONFIRM_HOURS,
} from '../group-offers.service';

/** A positive EGP amount of at most 1,000,000 with two decimals at most. */
const MONEY = /^(?!0+(\.0{1,2})?$)\d{1,7}(\.\d{1,2})?$/;
const STATUSES = [
  'interest',
  'open',
  'confirmed',
  'failed',
  'cancelled',
  'reconfirming',
  'contracted',
] as const;

function Text(range: { min: number; max: number }) {
  return (target: object, key: string) => {
    ApiProperty({ type: String, minLength: range.min, maxLength: range.max })(
      target,
      key,
    );
    IsString()(target, key);
    Length(range.min, range.max, withParams({ ...range }))(target, key);
  };
}

export class CreateGroupOfferDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'The partner giving the price, when it is one of the compound’s.',
  })
  @IsOptional()
  @IsUUID('all')
  partnerId?: string;

  @Text(GROUP_TITLE_LENGTH)
  titleEn: string;

  @Text(GROUP_TITLE_LENGTH)
  titleAr: string;

  @Text(GROUP_BODY_LENGTH)
  bodyEn: string;

  @Text(GROUP_BODY_LENGTH)
  bodyAr: string;

  @ApiProperty({ type: String, pattern: MONEY.source, example: '1200.00' })
  @IsString()
  @Matches(MONEY)
  listPrice: string;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    example: '950.00',
    description: 'Below the list price (INVALID_VALUE).',
  })
  @IsString()
  @Matches(MONEY)
  groupPrice: string;

  @ApiProperty({ type: Number, minimum: 2, maximum: 1000 })
  @IsInt(withParams({ min: 2, max: 1000 }))
  @Min(2, withParams({ min: 2, max: 1000 }))
  @Max(1000, withParams({ min: 2, max: 1000 }))
  minParticipants: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: 2,
    maximum: 10000,
    description: 'The most quantity it takes in all; not below the minimum.',
  })
  @IsOptional()
  @IsInt(withParams({ min: 2, max: 10000 }))
  @Min(2, withParams({ min: 2, max: 10000 }))
  @Max(10000, withParams({ min: 2, max: 10000 }))
  maxParticipants?: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    description:
      'An interest phase first, until then: a non-binding count. Before `closesAt`.',
  })
  @IsOptional()
  @ToInstant()
  @IsDate()
  interestClosesAt?: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @ToInstant()
  @IsDate()
  closesAt: Date;
}

export class GroupOfferUnitDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'One of the caller’s units.',
  })
  @IsUUID('all')
  unitId: string;
}

export class JoinGroupOfferDto extends GroupOfferUnitDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: MAX_QUANTITY })
  @IsInt(withParams({ min: 1, max: MAX_QUANTITY }))
  @Min(1, withParams({ min: 1, max: MAX_QUANTITY }))
  @Max(MAX_QUANTITY, withParams({ min: 1, max: MAX_QUANTITY }))
  quantity: number;
}

export class GroupOfferReasonDto {
  @ApiProperty({
    type: String,
    description: 'A code of `groupOfferCancel`.',
  })
  @IsString()
  reasonCode: string;
}

export class StaffGroupOffersQueryDto extends PageQueryDto {
  @ApiProperty({ enum: STATUSES, required: false })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];
}

/**
 * A confirmed offer's contract (ADR 0083): the final price, and the
 * supplier when it is named now. Above the group price, the participants
 * re-confirm within `reconfirmHours`.
 */
export class ContractGroupOfferDto {
  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    example: '980.00',
    description: 'The price agreed with the supplier, EGP.',
  })
  @IsString()
  @Matches(MONEY)
  finalPrice: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The partner it is contracted with; else the offer’s own.',
  })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: RECONFIRM_HOURS.min,
    maximum: RECONFIRM_HOURS.max,
    description: `Hours the participants have to re-confirm a higher price; ${RECONFIRM_HOURS.default} by default.`,
  })
  @IsOptional()
  @IsInt(withParams({ min: RECONFIRM_HOURS.min, max: RECONFIRM_HOURS.max }))
  @Min(
    RECONFIRM_HOURS.min,
    withParams({ min: RECONFIRM_HOURS.min, max: RECONFIRM_HOURS.max }),
  )
  @Max(
    RECONFIRM_HOURS.max,
    withParams({ min: RECONFIRM_HOURS.min, max: RECONFIRM_HOURS.max }),
  )
  reconfirmHours?: number;
}
