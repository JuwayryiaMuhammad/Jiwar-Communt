import { ApiProperty } from '@nestjs/swagger';
import { BillingFrequency, InvoiceKind } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MONEY } from '../../money';

const NAME = { min: 1, max: 80 } as const;
/** What a fee pays for, to the residents it bills (ADR 0069). */
const DESCRIPTION = { min: 1, max: 1000 } as const;
const LEAD = { min: 0, max: 28 } as const;
const DUE = { min: 0, max: 90 } as const;
/** The first of a month, `YYYY-MM-01`. */
export const FIRST_OF_MONTH = /^\d{4}-(0[1-9]|1[0-2])-01$/;

export class CreateBillingPlanDto {
  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameEn: string;

  @ApiProperty({ type: String, minLength: NAME.min, maxLength: NAME.max })
  @IsString()
  @Length(NAME.min, NAME.max, withParams(NAME))
  nameAr: string;

  @ApiProperty({
    enum: InvoiceKind,
    enumName: 'InvoiceKind',
    description: 'Never changes.',
  })
  @IsEnum(InvoiceKind)
  kind: InvoiceKind;

  @ApiProperty({
    enum: BillingFrequency,
    enumName: 'BillingFrequency',
    description: 'Never changes.',
  })
  @IsEnum(BillingFrequency)
  frequency: BillingFrequency;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'Every unit, each period, unless overridden.',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiProperty({
    type: String,
    pattern: FIRST_OF_MONTH.source,
    description:
      'The first day of the first period: the first of a month, from this month to a year ahead. Never changes.',
  })
  @IsString()
  @Matches(FIRST_OF_MONTH)
  startsOn: string;

  @ApiProperty({
    type: Number,
    minimum: LEAD.min,
    maximum: LEAD.max,
    description: 'Issue a period’s invoices this many days before it starts.',
  })
  @IsInt(withParams(LEAD))
  @Min(LEAD.min, withParams(LEAD))
  @Max(LEAD.max, withParams(LEAD))
  issueDaysBefore: number;

  @ApiProperty({
    type: Number,
    minimum: DUE.min,
    maximum: DUE.max,
    description: 'An invoice is due this many days after it is issued.',
  })
  @IsInt(withParams(DUE))
  @Min(DUE.min, withParams(DUE))
  @Max(DUE.max, withParams(DUE))
  dueDaysAfterIssue: number;

  @ApiProperty({
    type: String,
    required: false,
    minLength: DESCRIPTION.min,
    maxLength: DESCRIPTION.max,
    description:
      'What the fee pays for, as the residents it bills read it (ADR 0069). With `descriptionAr`, or neither.',
  })
  @IsOptional()
  @IsString()
  @Length(DESCRIPTION.min, DESCRIPTION.max, withParams(DESCRIPTION))
  descriptionEn?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: DESCRIPTION.min,
    maxLength: DESCRIPTION.max,
  })
  @IsOptional()
  @IsString()
  @Length(DESCRIPTION.min, DESCRIPTION.max, withParams(DESCRIPTION))
  descriptionAr?: string;
}

/** What may change: applies to periods issued afterwards. */
export class UpdateBillingPlanDto {
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
  amount?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: LEAD.min,
    maximum: LEAD.max,
  })
  @IsOptional()
  @IsInt(withParams(LEAD))
  @Min(LEAD.min, withParams(LEAD))
  @Max(LEAD.max, withParams(LEAD))
  issueDaysBefore?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: DUE.min,
    maximum: DUE.max,
  })
  @IsOptional()
  @IsInt(withParams(DUE))
  @Min(DUE.min, withParams(DUE))
  @Max(DUE.max, withParams(DUE))
  dueDaysAfterIssue?: number;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'False retires the plan.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: DESCRIPTION.min,
    maxLength: DESCRIPTION.max,
    description:
      'What the fee pays for (ADR 0069). Both languages or neither: null clears both.',
  })
  @IsOptional()
  @IsString()
  @Length(DESCRIPTION.min, DESCRIPTION.max, withParams(DESCRIPTION))
  descriptionEn?: string | null;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: DESCRIPTION.min,
    maxLength: DESCRIPTION.max,
  })
  @IsOptional()
  @IsString()
  @Length(DESCRIPTION.min, DESCRIPTION.max, withParams(DESCRIPTION))
  descriptionAr?: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'With a new `amount` only: the board’s published decision that set it (ADR 0069), shown to the residents beside the change.',
  })
  @IsOptional()
  @IsUUID()
  decisionPublicationId?: string;
}

/** A unit's own terms in a plan: another amount, or excluded (exactly one). */
export class SetBillingOverrideDto {
  @ApiProperty({ type: String, required: false, pattern: MONEY.source })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  amount?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'True: the unit is not billed by this plan.',
  })
  @IsOptional()
  @IsBoolean()
  excluded?: boolean;
}
