import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDate,
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
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import { CONTRACT_KINDS } from '../../contracts/contract-rules';
import { MONEY } from '../../costs/cost-rules';
import { IsLocalDate, LOCAL_DATE } from '../../schedules/local-dates';
import { STOCK_CODE } from '../../stock/stock-rules';
import { VENDOR_CATEGORIES } from '../../vendors/vendor-rules';
import { TENDER_LIMITS, TENDER_STATUSES } from '../tender-rules';

const L = TENDER_LIMITS;

export class TendersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: TENDER_STATUSES, enumName: 'TenderStatus' })
  @IsOptional()
  @IsIn(TENDER_STATUSES, withParams({ allowed: [...TENDER_STATUSES] }))
  status?: (typeof TENDER_STATUSES)[number];
}

/** A tender's draft (ADR 0088). */
export class CreateTenderDto {
  @ApiProperty({
    type: String,
    minLength: L.title.min,
    maxLength: L.title.max,
    description: 'What is asked for; never a person.',
  })
  @IsString()
  @Length(L.title.min, L.title.max, withParams(L.title))
  title: string;

  @ApiPropertyOptional({
    type: String,
    minLength: L.scope.min,
    maxLength: L.scope.max,
    description: 'The scope of the work, in words; never a person.',
  })
  @IsOptional()
  @IsString()
  @Length(L.scope.min, L.scope.max, withParams(L.scope))
  scope?: string;

  @ApiProperty({ enum: VENDOR_CATEGORIES, enumName: 'VendorCategory' })
  @IsIn(VENDOR_CATEGORIES, withParams({ allowed: [...VENDOR_CATEGORIES] }))
  category: (typeof VENDOR_CATEGORIES)[number];

  @ApiProperty({
    enum: CONTRACT_KINDS,
    enumName: 'ContractKind',
    description: 'The contract its award signs.',
  })
  @IsIn(CONTRACT_KINDS, withParams({ allowed: [...CONTRACT_KINDS] }))
  contractKind: (typeof CONTRACT_KINDS)[number];

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'The budget line its contract is paid from.',
  })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    description: 'The management’s own estimate, EGP; bidders never see it.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  estimatedValue?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'With its offset: bids are taken until then (not at it), a year ahead at most; an hour ahead at least when it is published.',
  })
  @ToInstant()
  @IsDate()
  bidsDueAt: Date;
}

/** A draft's terms; null clears an optional one. */
export class UpdateTenderDto {
  @ApiPropertyOptional({
    type: String,
    minLength: L.title.min,
    maxLength: L.title.max,
  })
  @IsOptional()
  @IsString()
  @Length(L.title.min, L.title.max, withParams(L.title))
  title?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: L.scope.min,
    maxLength: L.scope.max,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(L.scope.min, L.scope.max, withParams(L.scope))
  scope?: string | null;

  @ApiPropertyOptional({ enum: VENDOR_CATEGORIES, enumName: 'VendorCategory' })
  @IsOptional()
  @IsIn(VENDOR_CATEGORIES, withParams({ allowed: [...VENDOR_CATEGORIES] }))
  category?: (typeof VENDOR_CATEGORIES)[number];

  @ApiPropertyOptional({ enum: CONTRACT_KINDS, enumName: 'ContractKind' })
  @IsOptional()
  @IsIn(CONTRACT_KINDS, withParams({ allowed: [...CONTRACT_KINDS] }))
  contractKind?: (typeof CONTRACT_KINDS)[number];

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  budgetLineId?: string | null;

  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  estimatedValue?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @ToInstant()
  @IsDate()
  bidsDueAt?: Date;
}

export class TenderDeadlineDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Later than the one before, which has not passed.',
  })
  @ToInstant()
  @IsDate()
  bidsDueAt: Date;
}

export class AddTenderDocumentDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A `tender_document` file I uploaded.',
  })
  @IsUUID()
  fileId: string;

  @ApiProperty({
    type: String,
    minLength: L.documentTitle.min,
    maxLength: L.documentTitle.max,
  })
  @IsString()
  @Length(L.documentTitle.min, L.documentTitle.max, withParams(L.documentTitle))
  title: string;
}

/**
 * A registered vendor (`vendorId`), or a company that is not registered
 * (`companyName`), which gets a bid link: one of the two.
 */
export class InviteDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @ValidateIf((o: InviteDto) => o.companyName === undefined)
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: L.companyName.min,
    maxLength: L.companyName.max,
    description: 'Not registered: its bid link is shown once.',
  })
  @ValidateIf((o: InviteDto) => o.vendorId === undefined)
  @IsString()
  @Length(L.companyName.min, L.companyName.max, withParams(L.companyName))
  companyName?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'email',
    description: 'Its business contact, for the management’s reference.',
  })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;
}

export class AwardTenderDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  bidId: string;

  @ApiProperty({
    type: String,
    pattern: STOCK_CODE.source,
    description: 'The contract’s code, unique in the compound.',
  })
  @IsString()
  @Matches(STOCK_CODE)
  code: string;

  @ApiProperty({ type: String, format: 'date', pattern: LOCAL_DATE.source })
  @IsString()
  @IsLocalDate()
  startsOn: string;

  @ApiProperty({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'Its last day; after `startsOn`.',
  })
  @IsString()
  @IsLocalDate()
  endsOn: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The board’s approved major contract: needed above the manager’s limit, of at least the bid’s amount; it signs this contract and no other.',
  })
  @IsOptional()
  @IsUUID()
  approvalRequestId?: string;
}

/** A bid (ADR 0088): sealed when it comes in. */
export class BidDto {
  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'EGP, more than zero; sealed until the opening.',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: L.durationDays.min,
    maximum: L.durationDays.max,
    description: 'How many days the work takes.',
  })
  @IsOptional()
  @IsInt()
  @Min(L.durationDays.min, withParams(L.durationDays))
  @Max(L.durationDays.max, withParams(L.durationDays))
  durationDays?: number;

  @ApiPropertyOptional({
    type: String,
    minLength: L.note.min,
    maxLength: L.note.max,
    description: 'The terms in words.',
  })
  @IsOptional()
  @IsString()
  @Length(L.note.min, L.note.max, withParams(L.note))
  note?: string;
}

export class ContractorBidDto extends BidDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A `tender_bid` file I uploaded: the offer.',
  })
  @IsOptional()
  @IsUUID()
  fileId?: string;
}

/** The token from the bid link's fragment, in the body. */
export class BidLinkTokenDto {
  @ApiProperty({ type: String, minLength: 43, maxLength: 43 })
  @IsString()
  token: string;
}

export class BidLinkBidDto extends BidDto {
  @ApiProperty({ type: String, minLength: 43, maxLength: 43 })
  @IsString()
  token: string;
}
