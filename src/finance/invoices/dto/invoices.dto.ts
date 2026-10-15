import { ApiProperty } from '@nestjs/swagger';
import { InvoiceKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MONEY } from '../../money';
import { INVOICE_FILTERS, type InvoiceFilter } from '../balances';

/** A local day of the compound, `YYYY-MM-DD`. */
export const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DESCRIPTION = { min: 1, max: 200 } as const;
const LINES = { min: 1, max: 20 } as const;
const BUILDING = { min: 1, max: 100 } as const;
export const ISSUE_TARGETS = ['unit', 'building', 'all'] as const;

export class InvoiceLineDto {
  @ApiProperty({
    type: String,
    minLength: DESCRIPTION.min,
    maxLength: DESCRIPTION.max,
  })
  @IsString()
  @Length(DESCRIPTION.min, DESCRIPTION.max, withParams(DESCRIPTION))
  descriptionEn: string;

  @ApiProperty({
    type: String,
    minLength: DESCRIPTION.min,
    maxLength: DESCRIPTION.max,
  })
  @IsString()
  @Length(DESCRIPTION.min, DESCRIPTION.max, withParams(DESCRIPTION))
  descriptionAr: string;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'EGP, e.g. `1500` or `1500.50`.',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;
}

/**
 * One issue (ADR 0046): the same invoice to one unit, a building's units or
 * every unit. `unitId` for `unit`, `building` for `building`, neither for
 * `all`.
 */
export class IssueInvoicesDto {
  @ApiProperty({ type: String, enum: ISSUE_TARGETS })
  @IsIn(ISSUE_TARGETS, withParams({ allowed: [...ISSUE_TARGETS] }))
  target: (typeof ISSUE_TARGETS)[number];

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: BUILDING.min,
    maxLength: BUILDING.max,
    description: 'Units whose building reads exactly this.',
  })
  @IsOptional()
  @IsString()
  @Length(BUILDING.min, BUILDING.max, withParams(BUILDING))
  building?: string;

  @ApiProperty({ enum: InvoiceKind, enumName: 'InvoiceKind' })
  @IsEnum(InvoiceKind)
  kind: InvoiceKind;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'A local day of the compound: from today to 366 days ahead.',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  dueOn: string;

  @ApiProperty({
    type: [InvoiceLineDto],
    minItems: LINES.min,
    maxItems: LINES.max,
  })
  @IsArray()
  @ArrayMinSize(LINES.min, withParams(LINES))
  @ArrayMaxSize(LINES.max, withParams(LINES))
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines: InvoiceLineDto[];
}

export class CreditNoteDto {
  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description:
      'At most its total less earlier credit notes. Beyond what it still owes, paid money is released to the unit’s credit (ADR 0048).',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiProperty({
    type: String,
    description:
      '`billing_error`, `waiver`, `duplicate`, `goodwill` or `other` (REASON_CODES.creditNote).',
  })
  @IsString()
  reasonCode: string;
}

export class InvoiceStatusQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    type: String,
    enum: INVOICE_FILTERS,
    description: '`open`: anything still owed.',
  })
  @IsOptional()
  @IsIn(INVOICE_FILTERS, withParams({ allowed: [...INVOICE_FILTERS] }))
  status?: InvoiceFilter;
}

export class StaffInvoicesQueryDto extends InvoiceStatusQueryDto {
  @ApiProperty({ required: false, enum: InvoiceKind, enumName: 'InvoiceKind' })
  @IsOptional()
  @IsEnum(InvoiceKind)
  kind?: InvoiceKind;

  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({ required: false, type: String, maxLength: BUILDING.max })
  @IsOptional()
  @IsString()
  @Length(BUILDING.min, BUILDING.max, withParams(BUILDING))
  building?: string;

  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  planId?: string;
}
