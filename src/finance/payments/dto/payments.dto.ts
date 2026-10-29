import { ApiProperty } from '@nestjs/swagger';
import { PaymentChannel, PaymentMethod } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import { MONEY } from '../../money';

export const OFFICE_METHODS = ['cash', 'bank_transfer', 'cheque'] as const;
/** A transfer's or cheque's reference, as written on it. */
export const REFERENCE = /^[A-Za-z0-9/-]{1,40}$/;
const NAMED = { max: 50 } as const;

/** A payment made at the office (ADR 0046). */
export class RecordOfficePaymentDto {
  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description:
      'At most what the invoices (named, or all the unit’s) still ask for.',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiProperty({ type: String, enum: OFFICE_METHODS })
  @IsIn(OFFICE_METHODS, withParams({ allowed: [...OFFICE_METHODS] }))
  method: (typeof OFFICE_METHODS)[number];

  @ApiProperty({
    type: String,
    required: false,
    pattern: REFERENCE.source,
    description: 'For a transfer or a cheque, and only for them.',
  })
  @IsOptional()
  @IsString()
  @Matches(REFERENCE)
  reference?: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The local day it was paid: today or up to 31 days ago.',
  })
  @IsString()
  @IsLocalDate()
  paidOn: string;

  @ApiProperty({
    type: [String],
    required: false,
    maxItems: NAMED.max,
    description:
      'Invoices to pay first (the unit’s, still owed); the rest goes oldest due first.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NAMED.max, withParams(NAMED))
  @ArrayUnique()
  @IsUUID('all', { each: true })
  invoiceIds?: string[];
}

export class ReversePaymentDto {
  @ApiProperty({
    type: String,
    description:
      '`entered_in_error`, `duplicate`, `bounced_cheque` or `other` (REASON_CODES.paymentReverse).',
  })
  @IsString()
  reasonCode: string;
}

export class StaffPaymentsQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    enum: PaymentChannel,
    enumName: 'PaymentChannel',
  })
  @IsOptional()
  @IsEnum(PaymentChannel)
  channel?: PaymentChannel;

  @ApiProperty({
    required: false,
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    required: false,
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Paid on or after.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  from?: string;

  @ApiProperty({
    required: false,
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Paid on or before.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  to?: string;
}
