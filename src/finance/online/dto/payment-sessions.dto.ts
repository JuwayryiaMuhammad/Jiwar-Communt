import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const BASKET = { max: 50 } as const;

/** What to pay online: some of the unit's invoices, or everything it owes. */
export class OpenPaymentSessionDto {
  @ApiProperty({
    type: [String],
    required: false,
    maxItems: BASKET.max,
    description: 'Omitted or empty: every invoice the unit owes.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BASKET.max, withParams(BASKET))
  @ArrayUnique()
  @IsUUID('all', { each: true })
  invoiceIds?: string[];
}
