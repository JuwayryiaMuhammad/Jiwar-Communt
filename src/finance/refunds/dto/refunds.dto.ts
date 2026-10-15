import { ApiProperty } from '@nestjs/swagger';
import { RefundChannel } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { MONEY } from '../../money';
import { LOCAL_DATE } from '../../invoices/dto/invoices.dto';
import { REFERENCE } from '../../payments/dto/payments.dto';

/**
 * A refund of the unit's credit, recorded by hand (ADR 0048): no call to the
 * gateway. At most the unit's credit when it is recorded.
 */
export class RecordRefundDto {
  @ApiProperty({
    type: String,
    pattern: MONEY.source,
    description: 'At most the unit’s credit now.',
  })
  @IsString()
  @Matches(MONEY)
  amount: string;

  @ApiProperty({
    enum: RefundChannel,
    enumName: 'RefundChannel',
    description:
      '`gateway_manual`: refunded by hand in the payment provider’s dashboard.',
  })
  @IsEnum(RefundChannel)
  channel: RefundChannel;

  @ApiProperty({
    type: String,
    required: false,
    pattern: REFERENCE.source,
    description: 'The transfer’s or the provider’s own reference, if any.',
  })
  @IsOptional()
  @IsString()
  @Matches(REFERENCE)
  reference?: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The local day the money was paid back: up to 31 days ago.',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  refundedOn: string;
}

export class ReverseRefundDto {
  @ApiProperty({
    type: String,
    description:
      '`entered_in_error`, `refund_failed` or `other` (REASON_CODES.refundReverse).',
  })
  @IsString()
  reasonCode: string;
}

export class RefundsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    required: false,
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Refunded on or after (local day).',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  from?: string;

  @ApiProperty({
    required: false,
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'Refunded on or before (local day).',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  to?: string;
}
