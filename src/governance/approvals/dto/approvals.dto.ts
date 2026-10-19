import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { LARGE_AMOUNT } from '../../../core/common/amounts';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  APPROVAL_FILTERS,
  APPROVAL_LIMITS,
  APPROVAL_TYPES,
  type ApprovalFilter,
} from '../approval-rules';
import type { ApprovalType } from '../../../core/board-matters/board-matters';

const BOOLEAN = ['true', 'false'] as const;
const L = APPROVAL_LIMITS;

const amount = (description: string, required = false) =>
  ApiProperty({
    type: String,
    required,
    pattern: LARGE_AMOUNT.source,
    description,
  });

export class ApprovalAlternativeDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: L.alternative })
  @IsString()
  @Length(1, L.alternative, withParams({ min: 1, max: L.alternative }))
  text: string;

  @amount('What the alternative would cost, EGP.')
  @IsOptional()
  @IsString()
  @Matches(LARGE_AMOUNT)
  cost?: string;
}

/**
 * A decision package for the board (ADR 0055). An annual budget names its
 * budget (a draft of finance's; its total is the cost), an increase the
 * line it raises (with the cost: what it adds); the others name nothing.
 */
export class RaiseApprovalDto {
  @ApiProperty({ enum: APPROVAL_TYPES, enumName: 'ApprovalType' })
  @IsIn(APPROVAL_TYPES, withParams({ allowed: [...APPROVAL_TYPES] }))
  type: ApprovalType;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'annual_budget only (FIELD_REQUIRED / FIELD_NOT_ALLOWED).',
  })
  @IsOptional()
  @IsUUID()
  budgetId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'budget_increase only: a line of the active budget.',
  })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: L.context })
  @IsString()
  @Length(1, L.context, withParams({ min: 1, max: L.context }))
  context: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: L.impact })
  @IsString()
  @Length(1, L.impact, withParams({ min: 1, max: L.impact }))
  impact: string;

  @amount(
    'EGP. Required for budget_increase (what it adds) and major_contract; not for annual_budget (its total).',
  )
  @IsOptional()
  @IsString()
  @Matches(LARGE_AMOUNT)
  cost?: string;

  @ApiProperty({
    type: [ApprovalAlternativeDto],
    required: false,
    maxItems: L.alternatives,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(L.alternatives, withParams({ max: L.alternatives }))
  @ValidateNested({ each: true })
  @Type(() => ApprovalAlternativeDto)
  alternatives?: ApprovalAlternativeDto[];

  @ApiProperty({
    type: [String],
    required: false,
    maxItems: L.attachments,
    description:
      'The caller’s uploads of purpose `approval_attachment` (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(L.attachments, withParams({ max: L.attachments }))
  @IsUUID('all', { each: true })
  attachmentIds?: string[];
}

export class ImplementedApprovalDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: L.implementationNote,
  })
  @IsOptional()
  @IsString()
  @Length(
    1,
    L.implementationNote,
    withParams({ min: 1, max: L.implementationNote }),
  )
  note?: string;
}

export class ApprovalsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: APPROVAL_FILTERS,
    enumName: 'ApprovalFilter',
    required: false,
    description: '`approved`: waiting to be implemented.',
  })
  @IsOptional()
  @IsIn(APPROVAL_FILTERS, withParams({ allowed: [...APPROVAL_FILTERS] }))
  status?: ApprovalFilter;

  @ApiProperty({
    enum: APPROVAL_TYPES,
    enumName: 'ApprovalType',
    required: false,
  })
  @IsOptional()
  @IsIn(APPROVAL_TYPES, withParams({ allowed: [...APPROVAL_TYPES] }))
  type?: ApprovalType;

  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description: 'Pending past the deadline only.',
  })
  @IsOptional()
  @IsIn(BOOLEAN, withParams({ allowed: [...BOOLEAN] }))
  overdue?: 'true' | 'false';
}
