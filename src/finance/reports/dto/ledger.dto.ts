import { ApiProperty } from '@nestjs/swagger';
import { Type as TransformType } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { HTTP_DEFAULT_LIMIT } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';

/** What the ledger journals (ADR 0048). */
export const LEDGER_TYPES = [
  'invoice',
  'credit_note',
  'payment',
  'payment_reversal',
  'refund',
  'refund_reversal',
  'credit_applied',
  'allocation_release',
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

const BUILDING = { min: 1, max: 100 } as const;
const LIMIT = { min: 1, max: 100 } as const;

/** A period of the compound's local days, both included. */
export class PeriodDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'First local day, included.',
  })
  @IsString()
  @IsLocalDate()
  from: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Last local day, included: at most 366 days after `from`.',
  })
  @IsString()
  @IsLocalDate()
  to: string;
}

/** The ledger's filters, shared by the page and its CSV export. */
export class LedgerFilterDto extends PeriodDto {
  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    required: false,
    type: String,
    maxLength: BUILDING.max,
    description: 'Units whose building reads exactly this.',
  })
  @IsOptional()
  @IsString()
  @Length(BUILDING.min, BUILDING.max, withParams(BUILDING))
  building?: string;

  @ApiProperty({ required: false, type: String, enum: LEDGER_TYPES })
  @IsOptional()
  @IsIn(LEDGER_TYPES, withParams({ allowed: [...LEDGER_TYPES] }))
  type?: LedgerType;
}

export class LedgerQueryDto extends LedgerFilterDto {
  @ApiProperty({
    required: false,
    type: String,
    description: 'Opaque cursor from the previous page (`nextCursor`).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 512, withParams({ min: 1, max: 512 }))
  cursor?: string;

  @ApiProperty({
    required: false,
    type: Number,
    minimum: LIMIT.min,
    maximum: LIMIT.max,
    default: HTTP_DEFAULT_LIMIT,
  })
  @IsOptional()
  @TransformType(() => Number)
  @IsInt(withParams(LIMIT))
  @Min(LIMIT.min, withParams(LIMIT))
  @Max(LIMIT.max, withParams(LIMIT))
  limit: number = HTTP_DEFAULT_LIMIT;
}
