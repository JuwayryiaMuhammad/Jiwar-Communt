import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
import { IsLocalDate, LOCAL_DATE } from '../../schedules/local-dates';
import {
  LINE_KINDS,
  LINE_TAX_CODES,
  ORDER_LIMITS,
  ORDER_PRICE,
  ORDER_QUANTITY,
  ORDER_QUANTITY_OR_ZERO,
  ORDER_STATUSES,
  ORDER_UNITS,
  WITHHOLDING_CATEGORY_LIST,
  type LineKind,
  type LineTaxCode,
  type OrderStatus,
  type OrderWithholdingCategory,
} from '../purchase-order-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const TAX_CODE_LIST = Object.keys(LINE_TAX_CODES) as LineTaxCode[];

/** One line of an order, as raised or amended. */
export class PurchaseOrderLineDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'An amendment: the existing line this changes. Absent: a new line. A line left out of an amendment is dropped (only while nothing was received or invoiced of it).',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({
    enum: LINE_KINDS,
    enumName: 'PurchaseOrderLineKind',
    description:
      '`stock`: a stock item, received into a store; `goods`: other goods, confirmed received; `service`: confirmed done.',
  })
  @IsIn(LINE_KINDS, allowed(LINE_KINDS))
  kind: LineKind;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A `stock` line’s item (its unit is the line’s).',
  })
  @IsOptional()
  @IsUUID()
  stockItemId?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: ORDER_LIMITS.description,
    description: 'Required unless the line is a stock item’s.',
  })
  @IsOptional()
  @IsString()
  @Length(1, ORDER_LIMITS.description, withParams({ min: 1, max: 200 }))
  description?: string;

  @ApiProperty({ type: String, pattern: ORDER_QUANTITY.source })
  @IsString()
  @Matches(ORDER_QUANTITY)
  quantity: string;

  @ApiPropertyOptional({
    enum: ORDER_UNITS,
    enumName: 'PurchaseOrderUnit',
    description: 'Required unless the line is a stock item’s.',
  })
  @IsOptional()
  @IsIn(ORDER_UNITS, allowed(ORDER_UNITS))
  unit?: string;

  @ApiProperty({
    type: String,
    pattern: ORDER_PRICE.source,
    description: 'EGP, net of VAT, for one.',
  })
  @IsString()
  @Matches(ORDER_PRICE)
  unitPrice: string;

  @ApiPropertyOptional({
    enum: TAX_CODE_LIST,
    enumName: 'TaxCode',
    description: '`zero` by default.',
  })
  @IsOptional()
  @IsIn(TAX_CODE_LIST, allowed(TAX_CODE_LIST))
  taxCode?: LineTaxCode;

  @ApiPropertyOptional({
    enum: WITHHOLDING_CATEGORY_LIST,
    enumName: 'WithholdingCategory',
    description:
      'What its payout withholds by (ADR 0093); absent: the invoice’s, else the vendor’s.',
  })
  @IsOptional()
  @IsIn(WITHHOLDING_CATEGORY_LIST, allowed(WITHHOLDING_CATEGORY_LIST))
  withholdingCategory?: OrderWithholdingCategory;
}

export class CreatePurchaseOrderDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'Raised from an approved purchase request (it takes the request’s budget line and vendor).',
  })
  @IsOptional()
  @IsUUID()
  purchaseRequestId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'Raised from an awarded tender (its vendor; its contract must keep no payment schedule).',
  })
  @IsOptional()
  @IsUUID()
  tenderId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A vendor of the register; required for a direct order.',
  })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Required unless its request or tender names one.',
  })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiProperty({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'Not before the compound’s today.',
  })
  @IsString()
  @IsLocalDate()
  deliveryOn: string;

  @ApiPropertyOptional({ type: String, maxLength: ORDER_LIMITS.note })
  @IsOptional()
  @IsString()
  @Length(1, ORDER_LIMITS.note, withParams({ min: 1, max: 500 }))
  note?: string;

  @ApiProperty({
    type: [PurchaseOrderLineDto],
    minItems: 1,
    maxItems: ORDER_LIMITS.lines,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: ORDER_LIMITS.lines }))
  @ArrayMaxSize(
    ORDER_LIMITS.lines,
    withParams({ min: 1, max: ORDER_LIMITS.lines }),
  )
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines: PurchaseOrderLineDto[];
}

export class AmendPurchaseOrderDto {
  @ApiProperty({
    type: String,
    description: 'REASON_CODES.purchaseOrderAmend.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  budgetLineId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'Not before the compound’s today.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  deliveryOn?: string;

  @ApiPropertyOptional({ type: String, maxLength: ORDER_LIMITS.note })
  @IsOptional()
  @IsString()
  @Length(1, ORDER_LIMITS.note, withParams({ min: 1, max: 500 }))
  note?: string;

  @ApiProperty({
    type: [PurchaseOrderLineDto],
    minItems: 1,
    maxItems: ORDER_LIMITS.lines,
    description:
      'The whole order as amended: a line that carries its `id` changes, one without is new, one left out is dropped.',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: ORDER_LIMITS.lines }))
  @ArrayMaxSize(
    ORDER_LIMITS.lines,
    withParams({ min: 1, max: ORDER_LIMITS.lines }),
  )
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines: PurchaseOrderLineDto[];
}

export class ApprovePurchaseOrderDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'Above the manager’s limit: the board’s approved major contract of at least the order’s total, covering no other order, request or contract.',
  })
  @IsOptional()
  @IsUUID()
  approvalRequestId?: string;

  @ApiPropertyOptional({ type: String, maxLength: ORDER_LIMITS.decisionNote })
  @IsOptional()
  @IsString()
  @Length(1, ORDER_LIMITS.decisionNote, withParams({ min: 1, max: 1000 }))
  note?: string;
}

export class RejectPurchaseOrderDto {
  @ApiProperty({
    type: String,
    description: 'REASON_CODES.purchaseOrderReject.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({ type: String, maxLength: ORDER_LIMITS.decisionNote })
  @IsOptional()
  @IsString()
  @Length(1, ORDER_LIMITS.decisionNote, withParams({ min: 1, max: 1000 }))
  note?: string;
}

export class PurchaseOrdersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ORDER_STATUSES,
    enumName: 'PurchaseOrderStatus',
  })
  @IsOptional()
  @IsIn(ORDER_STATUSES, allowed(ORDER_STATUSES))
  status?: OrderStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  purchaseRequestId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenderId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Only orders waiting for a decision: a first approval or a revision.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  waiting?: boolean;
}

/** One line of a receipt: what was accepted and rejected of an order's line. */
export class GoodsReceiptLineDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  purchaseOrderLineId: string;

  @ApiProperty({
    type: String,
    pattern: ORDER_QUANTITY_OR_ZERO.source,
    description:
      'In the line’s unit; at most the ordered quantity and the compound’s tolerance in all (GOODS_RECEIPT_EXCEEDS_ORDER).',
  })
  @IsString()
  @Matches(ORDER_QUANTITY_OR_ZERO)
  accepted: string;

  @ApiPropertyOptional({ type: String, pattern: ORDER_QUANTITY_OR_ZERO.source })
  @IsOptional()
  @IsString()
  @Matches(ORDER_QUANTITY_OR_ZERO)
  rejected?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'REASON_CODES.goodsRejection; required with a rejection.',
  })
  @IsOptional()
  @IsString()
  rejectReason?: string;

  @ApiPropertyOptional({ type: String, maxLength: ORDER_LIMITS.note })
  @IsOptional()
  @IsString()
  @Length(1, ORDER_LIMITS.note, withParams({ min: 1, max: 500 }))
  note?: string;
}

export class CreateGoodsReceiptDto {
  @ApiProperty({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'Not after the compound’s today.',
  })
  @IsString()
  @IsLocalDate()
  receivedOn: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The store the accepted stock lines go into; required with one, refused without.',
  })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: ORDER_LIMITS.deliveryNote,
    description: 'The vendor’s delivery note’s number.',
  })
  @IsOptional()
  @IsString()
  @Length(1, ORDER_LIMITS.deliveryNote, withParams({ min: 1, max: 60 }))
  deliveryNote?: string;

  @ApiPropertyOptional({ type: String, maxLength: ORDER_LIMITS.note })
  @IsOptional()
  @IsString()
  @Length(1, ORDER_LIMITS.note, withParams({ min: 1, max: 500 }))
  note?: string;

  @ApiProperty({
    type: [GoodsReceiptLineDto],
    minItems: 1,
    maxItems: ORDER_LIMITS.lines,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: ORDER_LIMITS.lines }))
  @ArrayMaxSize(
    ORDER_LIMITS.lines,
    withParams({ min: 1, max: ORDER_LIMITS.lines }),
  )
  @ValidateNested({ each: true })
  @Type(() => GoodsReceiptLineDto)
  lines: GoodsReceiptLineDto[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: ORDER_LIMITS.photos,
    description: 'The caller’s `goods_receipt_photo` uploads.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ORDER_LIMITS.photos, withParams({ max: ORDER_LIMITS.photos }))
  @IsUUID('all', { each: true })
  photoFileIds?: string[];
}
