import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { LARGE_AMOUNT } from '../../../core/common/amounts';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate, LOCAL_DATE } from '../../schedules/local-dates';
import {
  PURCHASE_LIMITS,
  PURCHASE_STATUSES,
  QUANTITY,
  type PurchaseStatus,
} from '../purchase-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });

export class CreatePurchaseRequestDto {
  @ApiProperty({
    type: String,
    minLength: PURCHASE_LIMITS.title.min,
    maxLength: PURCHASE_LIMITS.title.max,
    description: 'What is needed, about the work: never about a person.',
  })
  @IsString()
  @Length(
    PURCHASE_LIMITS.title.min,
    PURCHASE_LIMITS.title.max,
    withParams(PURCHASE_LIMITS.title),
  )
  title: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: PURCHASE_LIMITS.description.max,
  })
  @IsOptional()
  @IsString()
  @Length(
    PURCHASE_LIMITS.description.min,
    PURCHASE_LIMITS.description.max,
    withParams(PURCHASE_LIMITS.description),
  )
  description?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'A vendor of the register to buy from; a suspended one is refused.',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'The budget line it would be paid from.',
  })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'The store’s item it restocks (ADR 0065), with `quantity`.',
  })
  @IsOptional()
  @IsUUID()
  stockItemId?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: QUANTITY.source,
    description: 'In the item’s unit; with `stockItemId`.',
  })
  @IsOptional()
  @IsString()
  @Matches(QUANTITY)
  quantity?: string;

  @ApiProperty({
    type: String,
    pattern: LARGE_AMOUNT.source,
    description:
      'EGP. Above the manager’s limit the board’s approval covers it.',
  })
  @IsString()
  @Matches(LARGE_AMOUNT)
  estimatedAmount: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'Not before the compound’s today.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  neededBy?: string;
}

export class ApprovePurchaseRequestDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'Above the manager’s limit: the board’s approved major contract of at least the amount, covering no other request or contract.',
  })
  @IsOptional()
  @IsUUID()
  approvalRequestId?: string;

  @ApiPropertyOptional({ type: String, maxLength: PURCHASE_LIMITS.note.max })
  @IsOptional()
  @IsString()
  @Length(
    PURCHASE_LIMITS.note.min,
    PURCHASE_LIMITS.note.max,
    withParams(PURCHASE_LIMITS.note),
  )
  note?: string;
}

export class RejectPurchaseRequestDto {
  @ApiProperty({ type: String, description: 'REASON_CODES.purchaseReject.' })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({ type: String, maxLength: PURCHASE_LIMITS.note.max })
  @IsOptional()
  @IsString()
  @Length(
    PURCHASE_LIMITS.note.min,
    PURCHASE_LIMITS.note.max,
    withParams(PURCHASE_LIMITS.note),
  )
  note?: string;
}

export class FulfilPurchaseRequestDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: PURCHASE_LIMITS.reference.max,
    description: 'What paid it: an expense’s number, an invoice’s reference.',
  })
  @IsOptional()
  @IsString()
  @Length(
    PURCHASE_LIMITS.reference.min,
    PURCHASE_LIMITS.reference.max,
    withParams(PURCHASE_LIMITS.reference),
  )
  reference?: string;
}

export class PurchaseRequestsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: PURCHASE_STATUSES,
    enumName: 'PurchaseRequestStatus',
  })
  @IsOptional()
  @IsIn(PURCHASE_STATUSES, allowed(PURCHASE_STATUSES))
  status?: PurchaseStatus;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Only the caller’s; a requester who does not approve always sees only theirs.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  mine?: boolean;
}
