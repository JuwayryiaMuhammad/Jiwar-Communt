import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
import { LARGE_AMOUNT } from '../../../core/common/amounts';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import {
  DISBURSEMENT_KINDS,
  GUARANTEE_KINDS,
  INVOICE_STATUSES,
  PAYABLE_LIMITS as L,
  PAYOUT_METHODS,
  TAX_CODE_LIST,
  type DisbursementKind,
  type GuaranteeKind,
  type InvoiceStatus,
  type PayoutMethod,
  type TaxCode,
} from '../payable-rules';

/** A positive amount or zero, as a line's month may be. */
const AMOUNT_OR_ZERO = /^\d{1,9}(\.\d{1,2})?$/;

// ----------------------------------------------------------------------------
// Budget planning
// ----------------------------------------------------------------------------

export class BudgetTransferDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A line of the active budget.',
  })
  @IsUUID()
  fromLineId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Another line of the same budget.',
  })
  @IsUUID()
  toLineId: string;

  @ApiProperty({
    type: String,
    pattern: LARGE_AMOUNT.source,
    description:
      'EGP; at most what the line it leaves has available (BUDGET_LINE_INSUFFICIENT).',
  })
  @IsString()
  @Matches(LARGE_AMOUNT)
  amount: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: L.transferReason })
  @IsString()
  @Length(1, L.transferReason, withParams({ min: 1, max: L.transferReason }))
  reason: string;
}

export class TransfersQueryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  budgetId: string;
}

export class LinePhasingDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  lineId: string;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description:
      'Twelve amounts, the fiscal year’s first month first, adding up to the line’s amount; null splits it evenly again. Or `quarters`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(12, withParams({ min: 12, max: 12 }))
  @ArrayMaxSize(12, withParams({ min: 12, max: 12 }))
  @Matches(AMOUNT_OR_ZERO, { each: true })
  months?: string[] | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Four amounts, each spread on its three months (a third each).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(4, withParams({ min: 4, max: 4 }))
  @ArrayMaxSize(4, withParams({ min: 4, max: 4 }))
  @Matches(AMOUNT_OR_ZERO, { each: true })
  quarters?: string[];
}

export class BudgetPhasingDto {
  @ApiProperty({ type: [LinePhasingDto], maxItems: 10 })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: 10 }))
  @ArrayMaxSize(10, withParams({ min: 1, max: 10 }))
  @ValidateNested({ each: true })
  @Type(() => LinePhasingDto)
  lines: LinePhasingDto[];
}

export class VarianceReasonDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 12,
    description: '1 is the fiscal year’s first month.',
  })
  @IsInt(withParams({ min: 1, max: 12 }))
  @Min(1, withParams({ min: 1, max: 12 }))
  @Max(12, withParams({ min: 1, max: 12 }))
  month: number;

  @ApiProperty({ type: String, description: 'A `budgetVariance` code.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: L.note })
  @IsOptional()
  @IsString()
  @Length(1, L.note, withParams({ min: 1, max: L.note }))
  note?: string;
}

export class PeriodsQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'By default the active budget of the year under way.',
  })
  @IsOptional()
  @IsUUID()
  budgetId?: string;

  @ApiPropertyOptional({ enum: ['month', 'quarter'] })
  @IsOptional()
  @IsIn(['month', 'quarter'], withParams({ allowed: ['month', 'quarter'] }))
  by?: 'month' | 'quarter';
}

export class CommitmentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  lineId?: string;

  @ApiPropertyOptional({ enum: ['contract', 'purchase_request'] })
  @IsOptional()
  @IsIn(
    ['contract', 'purchase_request'],
    withParams({ allowed: ['contract', 'purchase_request'] }),
  )
  source?: 'contract' | 'purchase_request';

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Open only (true) or closed only (false).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  open?: boolean;
}

// ----------------------------------------------------------------------------
// Vendors' invoices
// ----------------------------------------------------------------------------

export class VendorInvoiceLineDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: L.lineDescription })
  @IsString()
  @Length(1, L.lineDescription, withParams({ min: 1, max: L.lineDescription }))
  description: string;

  @ApiProperty({
    type: String,
    pattern: LARGE_AMOUNT.source,
    description: 'EGP, before tax.',
  })
  @IsString()
  @Matches(LARGE_AMOUNT)
  amount: string;

  @ApiPropertyOptional({
    enum: TAX_CODE_LIST,
    enumName: 'TaxCode',
    description: 'zero by default.',
  })
  @IsOptional()
  @IsIn(TAX_CODE_LIST, withParams({ allowed: [...TAX_CODE_LIST] }))
  taxCode?: TaxCode;
}

export class RecordVendorInvoiceDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The vendor: its contract’s or purchase’s; required for a purchase that named none (VENDOR_INVOICE_SOURCE_INVALID `vendor_mismatch` when it differs).',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: L.vendorNumber,
    description:
      'The vendor’s own invoice number: once among its live invoices, whatever its case (VENDOR_INVOICE_DUPLICATE).',
  })
  @IsString()
  @Length(1, L.vendorNumber, withParams({ min: 1, max: L.vendorNumber }))
  vendorNumber: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The invoice’s date, not ahead.',
  })
  @IsString()
  @IsLocalDate()
  issuedOn: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'When it is to be paid, not before its date.',
  })
  @IsString()
  @IsLocalDate()
  dueOn: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'One of its contracts; or `purchaseRequestId`.',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A line of the contract’s schedule, unpaid and not invoiced.',
  })
  @IsOptional()
  @IsUUID()
  contractPaymentId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A purchase request it fulfilled.',
  })
  @IsOptional()
  @IsUUID()
  purchaseRequestId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The line it is paid from; by default its contract’s or purchase’s.',
  })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'The caller’s upload of purpose `expense_invoice`.',
  })
  @IsUUID()
  invoiceFileId: string;

  @ApiProperty({ type: [VendorInvoiceLineDto], minItems: 1, maxItems: L.lines })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: L.lines }))
  @ArrayMaxSize(L.lines, withParams({ min: 1, max: L.lines }))
  @ValidateNested({ each: true })
  @Type(() => VendorInvoiceLineDto)
  lines: VendorInvoiceLineDto[];

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: L.note })
  @IsOptional()
  @IsString()
  @Length(1, L.note, withParams({ min: 1, max: L.note }))
  note?: string;
}

export class ApproveVendorInvoiceDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A line of the active budget, if not its own.',
  })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'Above the manager’s limit: the board’s approved major contract to spend down, if not its contract’s or purchase’s (EXPENSE_NEEDS_APPROVAL, EXPENSE_AUTHORIZATION_EXCEEDED); within it, FIELD_NOT_ALLOWED.',
  })
  @IsOptional()
  @IsUUID()
  authorizationId?: string;
}

export class PayoutDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The day it was paid: within its line’s budget year, not ahead.',
  })
  @IsString()
  @IsLocalDate()
  paidOn: string;

  @ApiProperty({ enum: PAYOUT_METHODS, enumName: 'PayoutMethod' })
  @IsIn(PAYOUT_METHODS, withParams({ allowed: [...PAYOUT_METHODS] }))
  method: PayoutMethod;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: L.reference,
    description: 'The transfer’s or the cheque’s reference.',
  })
  @IsOptional()
  @IsString()
  @Length(1, L.reference, withParams({ min: 1, max: L.reference }))
  reference?: string;
}

export class InvoicePayoutDto extends PayoutDto {
  @ApiPropertyOptional({
    type: String,
    pattern: LARGE_AMOUNT.source,
    description:
      'Of the contract’s open advances, set off against this invoice (ADVANCE_SET_OFF_EXCEEDED).',
  })
  @IsOptional()
  @IsString()
  @Matches(LARGE_AMOUNT)
  advanceSetOff?: string;
}

export class VendorInvoicesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: INVOICE_STATUSES,
    enumName: 'VendorInvoiceStatus',
  })
  @IsOptional()
  @IsIn(INVOICE_STATUSES, withParams({ allowed: [...INVOICE_STATUSES] }))
  status?: InvoiceStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  purchaseRequestId?: string;
}

export class PaymentScheduleQueryDto {
  @ApiPropertyOptional({ type: String, pattern: LOCAL_DATE.source })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: LOCAL_DATE.source,
    description: `At most ${L.periodDays} days after \`from\`.`,
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}

export class FinanceEntriesQueryDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The first day.',
  })
  @IsString()
  @IsLocalDate()
  from: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: `The last day, at most ${L.periodDays} days on.`,
  })
  @IsString()
  @IsLocalDate()
  to: string;
}

// ----------------------------------------------------------------------------
// A contract's money
// ----------------------------------------------------------------------------

export class DisbursementDto {
  @ApiProperty({ enum: DISBURSEMENT_KINDS, enumName: 'DisbursementKind' })
  @IsIn(DISBURSEMENT_KINDS, withParams({ allowed: [...DISBURSEMENT_KINDS] }))
  kind: DisbursementKind;

  @ApiProperty({
    type: String,
    pattern: LARGE_AMOUNT.source,
    description:
      'EGP: an advance within what the contract’s value leaves (ADVANCE_EXCEEDED); a release within what is held (RETENTION_EXCEEDED), after its end (RETENTION_NOT_DUE).',
  })
  @IsString()
  @Matches(LARGE_AMOUNT)
  amount: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: L.note })
  @IsOptional()
  @IsString()
  @Length(1, L.note, withParams({ min: 1, max: L.note }))
  note?: string;
}

export class GuaranteeDto {
  @ApiProperty({ enum: GUARANTEE_KINDS, enumName: 'GuaranteeKind' })
  @IsIn(GUARANTEE_KINDS, withParams({ allowed: [...GUARANTEE_KINDS] }))
  kind: GuaranteeKind;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: L.issuer,
    description: 'The bank that issued it.',
  })
  @IsString()
  @Length(1, L.issuer, withParams({ min: 1, max: L.issuer }))
  issuer: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: L.guaranteeReference })
  @IsString()
  @Length(
    1,
    L.guaranteeReference,
    withParams({ min: 1, max: L.guaranteeReference }),
  )
  reference: string;

  @ApiProperty({
    type: String,
    pattern: LARGE_AMOUNT.source,
    description: 'EGP.',
  })
  @IsString()
  @Matches(LARGE_AMOUNT)
  amount: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The day it was issued.',
  })
  @IsString()
  @IsLocalDate()
  issuedOn: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The day it expires, not before it was issued.',
  })
  @IsString()
  @IsLocalDate()
  expiresOn: string;
}

export class GuaranteeCloseDto {
  @ApiProperty({ enum: ['returned', 'called'] })
  @IsIn(['returned', 'called'], withParams({ allowed: ['returned', 'called'] }))
  outcome: 'returned' | 'called';
}

export class VarianceSettingDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 100,
    description:
      'Past this share of a month’s plan, a closed month asks for a reason; null: never.',
  })
  @ValidateIf(
    (o: { varianceReasonPct: unknown }) => o.varianceReasonPct !== null,
  )
  @IsInt(withParams({ min: 1, max: 100 }))
  @Min(1, withParams({ min: 1, max: 100 }))
  @Max(100, withParams({ min: 1, max: 100 }))
  varianceReasonPct: number | null;
}
