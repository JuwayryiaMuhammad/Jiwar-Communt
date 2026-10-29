import { ApiProperty } from '@nestjs/swagger';
import { ClubDurationKind } from '@prisma/client';
import { Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';

const NAME = { min: 1, max: 80 } as const;
const DAYS = { min: 1, max: 730 } as const;
/** EGP, at most 1,000,000, two decimals at most. */
export const MONEY = /^(?!0+(\.0{1,2})?$)\d{1,7}(\.\d{1,2})?$/;
export const RECEIPT = /^[A-Za-z0-9/-]{1,40}$/;
const PEOPLE = 30;

export class CreateClubPlanDto {
  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr: string;

  @ApiProperty({
    enum: ClubDurationKind,
    enumName: 'ClubDurationKind',
    description: 'Never changes.',
  })
  @IsEnum(ClubDurationKind)
  durationKind: ClubDurationKind;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: DAYS.min,
    maximum: DAYS.max,
    description: 'A custom plan’s days; for it alone.',
  })
  @IsOptional()
  @IsInt(withParams(DAYS))
  @Min(DAYS.min, withParams(DAYS))
  @Max(DAYS.max, withParams(DAYS))
  durationDays?: number;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'EGP, e.g. `1500` or `1500.50`.',
  })
  @IsString()
  @Matches(MONEY)
  price: string;
}

export class UpdateClubPlanDto {
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
    type: String,
    required: false,
    minLength: NAME.min,
    maxLength: NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr?: string;

  @ApiProperty({ type: String, required: false, pattern: MONEY.source })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  price?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False retires the plan.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ClubPersonRefDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'One of the unit’s occupancies; or `memberId`.',
  })
  @IsOptional()
  @IsUUID()
  occupancyId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'One of the unit’s household members (a minor too).',
  })
  @IsOptional()
  @IsUUID()
  memberId?: string;
}

class ClubPeopleDto {
  @ApiProperty({
    type: [ClubPersonRefDto],
    maxItems: PEOPLE,
    description: 'Whom it covers: the unit’s people now (PERSON_NOT_OF_UNIT).',
  })
  @IsArray()
  @ArrayMaxSize(PEOPLE, withParams({ min: 0, max: PEOPLE }))
  @ValidateNested({ each: true })
  @Type(() => ClubPersonRefDto)
  people: ClubPersonRefDto[];
}

export class CreateClubMembershipDto extends ClubPeopleDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;
}

export class ReplaceClubPeopleDto extends ClubPeopleDto {}

export class RecordClubPaymentDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active plan (PLAN_NOT_AVAILABLE).',
  })
  @IsUUID()
  planId: string;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'What was paid, EGP.',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiProperty({ type: String, required: false, enum: ['EGP'], default: 'EGP' })
  @IsOptional()
  @IsIn(['EGP'])
  currency?: string;

  @ApiProperty({
    type: String,
    pattern: RECEIPT.source,
    description: 'Once per compound (DUPLICATE_VALUE).',
  })
  @IsString()
  @Matches(RECEIPT)
  receiptNumber: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The local day it was paid: not in the future, at most 90 days ago (PAID_ON_OUT_OF_RANGE).',
  })
  @IsString()
  @IsLocalDate()
  paidOn: string;
}

export class ReverseClubPaymentDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `clubPaymentReverse`.',
  })
  @IsString()
  reasonCode: string;
}

export class ClubMembershipsQueryDto {
  @ApiProperty({
    enum: ['active', 'expiring', 'expired', 'none'],
    required: false,
  })
  @IsOptional()
  @IsIn(['active', 'expiring', 'expired', 'none'])
  state?: 'active' | 'expiring' | 'expired' | 'none';
}

export class ClubUnitQueryDto {
  @ApiProperty({ type: String, description: 'The unit’s code, exactly.' })
  @IsString()
  @Length(1, 40, withParams({ min: 1, max: 40 }))
  code: string;
}
