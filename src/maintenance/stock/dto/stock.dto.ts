import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MONEY, QUANTITY } from '../../costs/cost-rules';
import {
  PART_REQUEST_STATUSES,
  REFERENCE_MAX,
  STOCK_CODE,
  STOCK_DELTA,
  STOCK_LEVEL,
  STOCK_UNITS,
  type PartRequestStatus,
  type StockUnit,
} from '../stock-rules';

const BOOL = ['true', 'false'] as const;
const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const STORE_NAME = { min: 1, max: 80 };
const ITEM_NAME = { min: 1, max: 120 };

export class CreateStoreDto {
  @ApiProperty({
    type: String,
    pattern: STOCK_CODE.source,
    description: 'The compound’s short code, unique. Never changes.',
  })
  @IsString()
  @Matches(STOCK_CODE)
  code: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: STORE_NAME.max })
  @IsString()
  @Length(STORE_NAME.min, STORE_NAME.max, withParams(STORE_NAME))
  nameAr: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: STORE_NAME.max })
  @IsString()
  @Length(STORE_NAME.min, STORE_NAME.max, withParams(STORE_NAME))
  nameEn: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'The common area it is in.',
  })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;
}

export class UpdateStoreDto {
  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: STORE_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(STORE_NAME.min, STORE_NAME.max, withParams(STORE_NAME))
  nameAr?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: STORE_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(STORE_NAME.min, STORE_NAME.max, withParams(STORE_NAME))
  nameEn?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: '`false` retires it: nothing goes in or out.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateStockItemDto {
  @ApiProperty({
    type: String,
    pattern: STOCK_CODE.source,
    description: 'The compound’s SKU, unique. Never changes.',
  })
  @IsString()
  @Matches(STOCK_CODE)
  sku: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: ITEM_NAME.max })
  @IsString()
  @Length(ITEM_NAME.min, ITEM_NAME.max, withParams(ITEM_NAME))
  nameAr: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: ITEM_NAME.max })
  @IsString()
  @Length(ITEM_NAME.min, ITEM_NAME.max, withParams(ITEM_NAME))
  nameEn: string;

  @ApiProperty({ enum: STOCK_UNITS, enumName: 'StockUnit' })
  @IsIn(STOCK_UNITS, allowed(STOCK_UNITS))
  unit: StockUnit;

  @ApiPropertyOptional({
    type: String,
    pattern: STOCK_LEVEL.source,
    description:
      'Warn who keeps the store once what it holds falls to this or below.',
  })
  @IsOptional()
  @IsString()
  @Matches(STOCK_LEVEL)
  reorderLevel?: string;
}

export class UpdateStockItemDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: ITEM_NAME.max })
  @IsOptional()
  @IsString()
  @Length(ITEM_NAME.min, ITEM_NAME.max, withParams(ITEM_NAME))
  nameAr?: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: ITEM_NAME.max })
  @IsOptional()
  @IsString()
  @Length(ITEM_NAME.min, ITEM_NAME.max, withParams(ITEM_NAME))
  nameEn?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: STOCK_LEVEL.source,
    description: '`null`: no reorder warning.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(STOCK_LEVEL)
  reorderLevel?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    description: '`false` retires it: no receipt, no request.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class StockItemsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: BOOL })
  @IsOptional()
  @IsIn(BOOL, allowed(BOOL))
  active?: (typeof BOOL)[number];

  @ApiPropertyOptional({
    enum: BOOL,
    description: '`true`: only those at or under their reorder level.',
  })
  @IsOptional()
  @IsIn(BOOL, allowed(BOOL))
  below?: (typeof BOOL)[number];
}

export class ReceiveStockDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  storeId: string;

  @ApiProperty({ type: String, pattern: QUANTITY.source })
  @IsString()
  @Matches(QUANTITY)
  quantity: string;

  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'EGP for one.',
  })
  @IsString()
  @Matches(MONEY)
  unitCost: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: REFERENCE_MAX,
    description: 'The delivery note or invoice number.',
  })
  @IsOptional()
  @IsString()
  @Length(1, REFERENCE_MAX, withParams({ min: 1, max: REFERENCE_MAX }))
  reference?: string;
}

export class AdjustStockDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  storeId: string;

  @ApiProperty({
    type: String,
    pattern: STOCK_DELTA.source,
    description: 'Signed: `-2` takes two off, `1.5` adds one and a half.',
  })
  @IsString()
  @Matches(STOCK_DELTA)
  delta: string;

  @ApiProperty({
    enum: REASON_CODES.stockAdjust,
    description: 'From the closed list `stockAdjust`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class TransferStockDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  fromStoreId: string;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  toStoreId: string;

  @ApiProperty({ type: String, pattern: QUANTITY.source })
  @IsString()
  @Matches(QUANTITY)
  quantity: string;
}

export class StockMovementsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  ticketId?: string;
}

export class StockCatalogueQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 60,
    description: 'Part of a SKU or a name.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 60, withParams({ min: 1, max: 60 }))
  q?: string;
}

export class PartRequestsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: PART_REQUEST_STATUSES,
    description: 'The open ones (requested and reserved) when left out.',
  })
  @IsOptional()
  @IsIn(PART_REQUEST_STATUSES, allowed(PART_REQUEST_STATUSES))
  status?: PartRequestStatus;
}

export class RequestPartDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  itemId: string;

  @ApiProperty({ type: String, pattern: QUANTITY.source })
  @IsString()
  @Matches(QUANTITY)
  quantity: string;
}

export class ReservePartDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Where it is held.',
  })
  @IsUUID()
  storeId: string;
}

export class ReturnPartDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  itemId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Where it goes back.',
  })
  @IsUUID()
  storeId: string;

  @ApiProperty({ type: String, pattern: QUANTITY.source })
  @IsString()
  @Matches(QUANTITY)
  quantity: string;
}
