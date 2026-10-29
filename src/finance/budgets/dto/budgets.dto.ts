import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
import { LARGE_AMOUNT } from '../../../core/common/amounts';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import {
  BUDGET_CATEGORIES,
  BUDGET_LIMITS,
  BUDGET_STATUSES,
  type BudgetCategory,
  type BudgetStatus,
} from '../budget-rules';

export class BudgetSettingsDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 12,
    description:
      'The month a fiscal year starts on; fixed once a budget exists (FISCAL_YEAR_LOCKED).',
  })
  @IsInt(withParams({ min: 1, max: 12 }))
  @Min(1, withParams({ min: 1, max: 12 }))
  @Max(12, withParams({ min: 1, max: 12 }))
  fiscalYearStartMonth: number;
}

export class DraftBudgetDto {
  @ApiProperty({
    type: Number,
    description:
      'The fiscal year, named after the calendar year it starts in: the one under way, the one before or the next.',
  })
  @IsInt()
  fiscalYear: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'Start from another budget’s lines.',
  })
  @IsOptional()
  @IsUUID()
  copyFromId?: string;
}

export class BudgetLineDto {
  @ApiProperty({ enum: BUDGET_CATEGORIES, enumName: 'BudgetCategory' })
  @IsIn(BUDGET_CATEGORIES, withParams({ allowed: [...BUDGET_CATEGORIES] }))
  category: BudgetCategory;

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
    required: false,
    minLength: 1,
    maxLength: BUDGET_LIMITS.note,
  })
  @IsOptional()
  @IsString()
  @Length(
    1,
    BUDGET_LIMITS.note,
    withParams({ min: 1, max: BUDGET_LIMITS.note }),
  )
  note?: string;
}

/** A draft's lines, as a whole: one per category. */
export class BudgetLinesDto {
  @ApiProperty({ type: [BudgetLineDto], maxItems: BUDGET_LIMITS.lines })
  @IsArray()
  @ArrayMaxSize(BUDGET_LIMITS.lines, withParams({ max: BUDGET_LIMITS.lines }))
  @ValidateNested({ each: true })
  @Type(() => BudgetLineDto)
  lines: BudgetLineDto[];
}

export class BudgetsQueryDto extends PageQueryDto {
  @ApiProperty({ type: Number, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  fiscalYear?: number;

  @ApiProperty({
    enum: BUDGET_STATUSES,
    enumName: 'BudgetStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(BUDGET_STATUSES, withParams({ allowed: [...BUDGET_STATUSES] }))
  status?: BudgetStatus;
}

export class RecordExpenseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A line of the active budget.',
  })
  @IsUUID()
  budgetLineId: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: BUDGET_LIMITS.vendor })
  @IsString()
  @Length(
    1,
    BUDGET_LIMITS.vendor,
    withParams({ min: 1, max: BUDGET_LIMITS.vendor }),
  )
  vendor: string;

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
    description: 'Within the budget’s year, not ahead (DAY_OUT_OF_RANGE).',
  })
  @IsString()
  @IsLocalDate()
  spentOn: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The caller’s upload of purpose `expense_invoice` (FILE_NOT_AVAILABLE).',
  })
  @IsUUID()
  invoiceFileId: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: BUDGET_LIMITS.reference,
  })
  @IsOptional()
  @IsString()
  @Length(
    1,
    BUDGET_LIMITS.reference,
    withParams({ min: 1, max: BUDGET_LIMITS.reference }),
  )
  reference?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'An approved major contract (GET /staff/finance/expense-authorizations): needed above the manager’s limit (EXPENSE_NEEDS_APPROVAL).',
  })
  @IsOptional()
  @IsUUID()
  authorizationId?: string;
}

export class ExpensesQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  budgetId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiProperty({ type: String, pattern: LOCAL_DATE.source, required: false })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiProperty({ type: String, pattern: LOCAL_DATE.source, required: false })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}
