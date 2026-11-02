import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MONEY } from '../../costs/cost-rules';
import { IsLocalDate, LOCAL_DATE } from '../../schedules/local-dates';
import { STOCK_CODE } from '../../stock/stock-rules';
import {
  CONTRACT_ASSETS_MAX,
  CONTRACT_KINDS,
  CONTRACT_NOTICE_DAYS,
  CONTRACT_PAYMENTS_MAX,
  CONTRACT_SCOPE,
  CONTRACT_STATUSES,
  CONTRACT_TERMS,
  PAYMENT_NOTE,
  PAYMENT_REFERENCE,
  VENDOR_NAME,
  VENDOR_PHONE,
  type ContractKind,
  type ContractStatus,
} from '../contract-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });

export class CreateContractDto {
  @ApiProperty({
    type: String,
    pattern: STOCK_CODE.source,
    description: 'The compound’s reference for it, unique. Never changes.',
  })
  @IsString()
  @Matches(STOCK_CODE)
  code: string;

  @ApiProperty({ enum: CONTRACT_KINDS, enumName: 'MaintenanceContractKind' })
  @IsIn(CONTRACT_KINDS, allowed(CONTRACT_KINDS))
  kind: ContractKind;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'A vendor of the register (ADR 0077); a suspended one is refused. Or `vendorName`.',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: VENDOR_NAME.max,
    description:
      'Without `vendorId`: the register’s vendor of this name (whatever its case), or a new one registered with it.',
  })
  @ValidateIf((o: { vendorId?: string }) => !o.vendorId)
  @IsString()
  @Length(VENDOR_NAME.min, VENDOR_NAME.max, withParams(VENDOR_NAME))
  vendorName?: string;

  @ApiPropertyOptional({ type: String, pattern: VENDOR_PHONE.source })
  @IsOptional()
  @IsString()
  @Matches(VENDOR_PHONE)
  vendorPhone?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: CONTRACT_SCOPE.max,
    description: 'What it covers, in the compound’s words.',
  })
  @IsOptional()
  @IsString()
  @Length(CONTRACT_SCOPE.min, CONTRACT_SCOPE.max, withParams(CONTRACT_SCOPE))
  scope?: string;

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
    pattern: MONEY.source,
    description: 'EGP a year.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  annualValue?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: CONTRACT_NOTICE_DAYS.min,
    maximum: CONTRACT_NOTICE_DAYS.max,
    default: 30,
    description: 'How many days before its end the end is announced.',
  })
  @IsOptional()
  @IsInt()
  @Min(CONTRACT_NOTICE_DAYS.min, withParams(CONTRACT_NOTICE_DAYS))
  @Max(CONTRACT_NOTICE_DAYS.max, withParams(CONTRACT_NOTICE_DAYS))
  noticeDays?: number;

  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    nullable: false,
    description: 'EGP a day the vendor owes for being late (ADR 0077).',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  latePenaltyPerDay?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    nullable: false,
    description: 'The late penalty at most in all; with `latePenaltyPerDay`.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  penaltyCap?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: false,
    minimum: CONTRACT_TERMS.responseHours.min,
    maximum: CONTRACT_TERMS.responseHours.max,
    description: 'Hours the vendor has to respond.',
  })
  @IsOptional()
  @IsInt()
  @Min(
    CONTRACT_TERMS.responseHours.min,
    withParams(CONTRACT_TERMS.responseHours),
  )
  @Max(
    CONTRACT_TERMS.responseHours.max,
    withParams(CONTRACT_TERMS.responseHours),
  )
  responseHours?: number;

  @ApiPropertyOptional({
    type: String,
    nullable: false,
    maxLength: CONTRACT_TERMS.penaltyTerms.max,
    description: 'Its penalties and service levels, in the contract’s words.',
  })
  @IsOptional()
  @IsString()
  @Length(
    CONTRACT_TERMS.penaltyTerms.min,
    CONTRACT_TERMS.penaltyTerms.max,
    withParams(CONTRACT_TERMS.penaltyTerms),
  )
  penaltyTerms?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Renews by itself unless notice is given; needs `renewalTermMonths`.',
  })
  @IsOptional()
  @IsBoolean()
  autoRenews?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: false,
    minimum: CONTRACT_TERMS.renewalTermMonths.min,
    maximum: CONTRACT_TERMS.renewalTermMonths.max,
  })
  @IsOptional()
  @IsInt()
  @Min(
    CONTRACT_TERMS.renewalTermMonths.min,
    withParams(CONTRACT_TERMS.renewalTermMonths),
  )
  @Max(
    CONTRACT_TERMS.renewalTermMonths.max,
    withParams(CONTRACT_TERMS.renewalTermMonths),
  )
  renewalTermMonths?: number;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: false,
    description: 'The budget line it is paid from (ADR 0055).',
  })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The board’s approved major contract it is signed under: needed above the manager’s limit, of at least the value, signing one contract. Set once.',
  })
  @IsOptional()
  @IsUUID()
  approvalRequestId?: string;
}

export class UpdateContractDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Another vendor of the register; a suspended one is refused.',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: VENDOR_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(VENDOR_NAME.min, VENDOR_NAME.max, withParams(VENDOR_NAME))
  vendorName?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: VENDOR_PHONE.source,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(VENDOR_PHONE)
  vendorPhone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: CONTRACT_SCOPE.max,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(CONTRACT_SCOPE.min, CONTRACT_SCOPE.max, withParams(CONTRACT_SCOPE))
  scope?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  startsOn?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  endsOn?: string;

  @ApiPropertyOptional({ type: String, nullable: true, pattern: MONEY.source })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  annualValue?: string | null;

  @ApiPropertyOptional({
    type: Number,
    minimum: CONTRACT_NOTICE_DAYS.min,
    maximum: CONTRACT_NOTICE_DAYS.max,
  })
  @IsOptional()
  @IsInt()
  @Min(CONTRACT_NOTICE_DAYS.min, withParams(CONTRACT_NOTICE_DAYS))
  @Max(CONTRACT_NOTICE_DAYS.max, withParams(CONTRACT_NOTICE_DAYS))
  noticeDays?: number;

  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    nullable: true,
    description: 'EGP a day the vendor owes for being late (ADR 0077).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  latePenaltyPerDay?: string | null;

  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    nullable: true,
    description: 'The late penalty at most in all; with `latePenaltyPerDay`.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  penaltyCap?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: CONTRACT_TERMS.responseHours.min,
    maximum: CONTRACT_TERMS.responseHours.max,
    description: 'Hours the vendor has to respond.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(
    CONTRACT_TERMS.responseHours.min,
    withParams(CONTRACT_TERMS.responseHours),
  )
  @Max(
    CONTRACT_TERMS.responseHours.max,
    withParams(CONTRACT_TERMS.responseHours),
  )
  responseHours?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: CONTRACT_TERMS.penaltyTerms.max,
    description: 'Its penalties and service levels, in the contract’s words.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(
    CONTRACT_TERMS.penaltyTerms.min,
    CONTRACT_TERMS.penaltyTerms.max,
    withParams(CONTRACT_TERMS.penaltyTerms),
  )
  penaltyTerms?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Renews by itself unless notice is given; needs `renewalTermMonths`.',
  })
  @IsOptional()
  @IsBoolean()
  autoRenews?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: CONTRACT_TERMS.renewalTermMonths.min,
    maximum: CONTRACT_TERMS.renewalTermMonths.max,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(
    CONTRACT_TERMS.renewalTermMonths.min,
    withParams(CONTRACT_TERMS.renewalTermMonths),
  )
  @Max(
    CONTRACT_TERMS.renewalTermMonths.max,
    withParams(CONTRACT_TERMS.renewalTermMonths),
  )
  renewalTermMonths?: number | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The budget line it is paid from (ADR 0055).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  budgetLineId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The board’s approved major contract it is signed under: needed above the manager’s limit, of at least the value, signing one contract. Set once.',
  })
  @IsOptional()
  @IsUUID()
  approvalRequestId?: string;
}

export class ContractAssetsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: CONTRACT_ASSETS_MAX,
    description: 'Every asset it covers from now on.',
  })
  @IsArray()
  @ArrayMaxSize(CONTRACT_ASSETS_MAX, withParams({ max: CONTRACT_ASSETS_MAX }))
  @IsUUID('all', { each: true })
  assetIds: string[];
}

export class ContractsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: CONTRACT_STATUSES,
    description: 'Read from its dates on the compound’s today.',
  })
  @IsOptional()
  @IsIn(CONTRACT_STATUSES, allowed(CONTRACT_STATUSES))
  status?: ContractStatus;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Covering it.',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Its vendor’s (ADR 0077).',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;
}

export class RenewContractDto {
  @ApiProperty({
    type: String,
    pattern: STOCK_CODE.source,
    description: 'The new contract’s reference, unique.',
  })
  @IsString()
  @Matches(STOCK_CODE)
  code: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'The day after the old one’s end by default.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  startsOn?: string;

  @ApiProperty({ type: String, format: 'date', pattern: LOCAL_DATE.source })
  @IsString()
  @IsLocalDate()
  endsOn: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: MONEY.source,
    description: 'EGP a year; the old one’s by default.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  annualValue?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The board’s approved major contract, above the manager’s limit.',
  })
  @IsOptional()
  @IsUUID()
  approvalRequestId?: string;
}

export class ContractPaymentDto {
  @ApiProperty({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'Within the contract’s dates; one payment a day.',
  })
  @IsString()
  @IsLocalDate()
  dueOn: string;

  @ApiProperty({ type: String, pattern: MONEY.source, description: 'EGP.' })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiPropertyOptional({ type: String, maxLength: PAYMENT_NOTE.max })
  @IsOptional()
  @IsString()
  @Length(PAYMENT_NOTE.min, PAYMENT_NOTE.max, withParams(PAYMENT_NOTE))
  note?: string;
}

export class ContractPaymentsDto {
  @ApiProperty({
    type: [ContractPaymentDto],
    maxItems: CONTRACT_PAYMENTS_MAX,
    description: 'Every unpaid payment from now on; what is paid stays.',
  })
  @IsArray()
  @ArrayMaxSize(
    CONTRACT_PAYMENTS_MAX,
    withParams({ max: CONTRACT_PAYMENTS_MAX }),
  )
  @ValidateNested({ each: true })
  @Type(() => ContractPaymentDto)
  payments: ContractPaymentDto[];
}

export class PayContractPaymentDto {
  @ApiProperty({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'Not after the compound’s today.',
  })
  @IsString()
  @IsLocalDate()
  paidOn: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: PAYMENT_REFERENCE.max,
    description: 'What paid it: an expense’s number, a transfer’s reference.',
  })
  @IsOptional()
  @IsString()
  @Length(
    PAYMENT_REFERENCE.min,
    PAYMENT_REFERENCE.max,
    withParams(PAYMENT_REFERENCE),
  )
  reference?: string;
}

export class DuePaymentsQueryDto {
  @ApiProperty({ type: String, format: 'date', pattern: LOCAL_DATE.source })
  @IsString()
  @IsLocalDate()
  from: string;

  @ApiProperty({ type: String, format: 'date', pattern: LOCAL_DATE.source })
  @IsString()
  @IsLocalDate()
  to: string;
}
