import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceKind } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { LARGE_AMOUNT } from '../../core/common/amounts';
import { PageQueryDto } from '../../core/common/http/list';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../core/common/validation/local-date';
import { BUDGET_CATEGORIES } from '../budgets/budget-rules';
import { GL_MONTH } from '../gl/gl-rules';
import { PAYOUT_METHODS, type PayoutMethod } from '../payables/payable-rules';
import {
  QUARTER,
  RATE,
  TAX_LIMITS as L,
  TAX_PAYMENT_KINDS,
  WITHHOLDING_CATEGORIES,
  type TaxPaymentKind,
  type WithholdingCategory,
} from './tax-rules';

const KINDS = Object.values(InvoiceKind);
/** An amount from zero: a threshold. */
export const AMOUNT_FROM_ZERO = /^\d{1,7}(\.\d{1,2})?$/;

export class TaxSettingsDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Registered for VAT: invoices of the taxable kinds carry VAT from now on, and the VAT vendors charge on the recoverable categories is recovered. Turned on the first time, VAT starts that day.',
  })
  @IsOptional()
  @IsBoolean()
  vatRegistered?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: L.vatNumber,
    description:
      'The tax registration number: required while registered (FIELD_REQUIRED).',
  })
  @IsOptional()
  @IsString()
  @Length(1, L.vatNumber, withParams({ min: 1, max: L.vatNumber }))
  vatNumber?: string | null;

  @ApiPropertyOptional({
    type: String,
    pattern: RATE.source,
    example: '14.00',
    description: 'In percent, above 0 and at most 100 (INVALID_VALUE).',
  })
  @IsOptional()
  @IsString()
  @Matches(RATE)
  vatRate?: string;

  @ApiPropertyOptional({
    enum: KINDS,
    enumName: 'InvoiceKind',
    isArray: true,
    description: 'The invoice kinds that carry VAT; none by default.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(KINDS.length, withParams({ max: KINDS.length }))
  @IsIn(KINDS, { each: true, ...withParams({ allowed: KINDS }) })
  taxableKinds?: InvoiceKind[];

  @ApiPropertyOptional({
    enum: BUDGET_CATEGORIES,
    isArray: true,
    description:
      'The budget categories whose input VAT is recovered while registered; none by default (the VAT stays part of the cost).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(
    BUDGET_CATEGORIES.length,
    withParams({ max: BUDGET_CATEGORIES.length }),
  )
  @IsIn(BUDGET_CATEGORIES, {
    each: true,
    ...withParams({ allowed: [...BUDGET_CATEGORIES] }),
  })
  recoverableCategories?: string[];

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Withhold tax from vendors’ payouts; off by default.',
  })
  @IsOptional()
  @IsBoolean()
  withholdingEnabled?: boolean;

  @ApiPropertyOptional({
    type: String,
    pattern: RATE.source,
    example: '1.00',
    description: 'Supplies, in percent (0–100).',
  })
  @IsOptional()
  @IsString()
  @Matches(RATE)
  suppliesRate?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: RATE.source,
    example: '3.00',
    description: 'Services and contracting, in percent (0–100).',
  })
  @IsOptional()
  @IsString()
  @Matches(RATE)
  servicesRate?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: RATE.source,
    example: '5.00',
    description: 'Professional fees, in percent (0–100).',
  })
  @IsOptional()
  @IsString()
  @Matches(RATE)
  professionalRate?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: AMOUNT_FROM_ZERO.source,
    example: '300.00',
    description:
      'An invoice whose subtotal is below it withholds nothing (EGP, from 0).',
  })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_FROM_ZERO)
  withholdingThreshold?: string;
}

export class TaxVendorDto {
  @ApiProperty({
    enum: WITHHOLDING_CATEGORIES,
    enumName: 'WithholdingCategory',
    nullable: true,
    description:
      'What its payouts withhold by; null: by its trades (professional, then supplies alone, else services).',
  })
  @ValidateIf((o: TaxVendorDto) => o.withholdingCategory !== null)
  @IsIn(
    WITHHOLDING_CATEGORIES,
    withParams({ allowed: [...WITHHOLDING_CATEGORIES] }),
  )
  withholdingCategory: WithholdingCategory | null;
}

export class VatDeclareDto {
  @ApiProperty({
    type: String,
    pattern: GL_MONTH.source,
    example: '2026-10',
    description:
      'The month: closed in the ledger (TAX_MONTH_NOT_CLOSED), the next to declare (TAX_MONTH_OUT_OF_ORDER {next}), once (TAX_MONTH_DECLARED).',
  })
  @IsString()
  @Matches(GL_MONTH)
  month: string;
}

export class TaxPaymentDto {
  @ApiProperty({ enum: TAX_PAYMENT_KINDS, enumName: 'TaxPaymentKind' })
  @IsIn(TAX_PAYMENT_KINDS, withParams({ allowed: [...TAX_PAYMENT_KINDS] }))
  kind: TaxPaymentKind;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'VAT: the declaration it pays (required); refused otherwise.',
  })
  @IsOptional()
  @IsUUID()
  declarationId?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: QUARTER.source,
    example: '2026-Q3',
    description:
      'Withholding: the calendar quarter it pays (required), not ahead; refused otherwise.',
  })
  @IsOptional()
  @IsString()
  @Matches(QUARTER)
  quarter?: string;

  @ApiProperty({
    type: String,
    pattern: LARGE_AMOUNT.source,
    description: 'At most what is still due (TAX_PAYMENT_EXCEEDED {open}).',
  })
  @IsString()
  @Matches(LARGE_AMOUNT)
  amount: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The day it was paid: not ahead, at most 31 days back.',
  })
  @IsString()
  @IsLocalDate()
  paidOn: string;

  @ApiProperty({ enum: PAYOUT_METHODS, enumName: 'PayoutMethod' })
  @IsIn(PAYOUT_METHODS, withParams({ allowed: [...PAYOUT_METHODS] }))
  method: PayoutMethod;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The bank or cash account it is paid from (ADR 0085): a cash box for cash, a bank account for a transfer or a cheque. CASH_ACCOUNT_WRONG_KIND, CASH_ACCOUNT_RETIRED, CASH_ACCOUNT_INSUFFICIENT.',
  })
  @IsUUID()
  cashAccountId: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: L.reference,
    description: 'The tax authority’s receipt or the transfer’s reference.',
  })
  @IsOptional()
  @IsString()
  @Length(1, L.reference, withParams({ min: 1, max: L.reference }))
  reference?: string;
}

export class TaxPaymentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: TAX_PAYMENT_KINDS, enumName: 'TaxPaymentKind' })
  @IsOptional()
  @IsIn(TAX_PAYMENT_KINDS, withParams({ allowed: [...TAX_PAYMENT_KINDS] }))
  kind?: TaxPaymentKind;
}

export class WithholdingCertificatesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String,
    pattern: QUARTER.source,
    example: '2026-Q3',
  })
  @IsOptional()
  @IsString()
  @Matches(QUARTER)
  quarter?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;
}
