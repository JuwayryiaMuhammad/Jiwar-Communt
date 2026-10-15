import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MONEY } from '../../money';

/** The opener's words (ADR 0048). */
export const DISPUTE_TEXT = { min: 1, max: 1000 } as const;
export const DISPUTE_STATUSES = ['open', 'accepted', 'rejected'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const DISPUTE_DECISIONS = ['accept', 'reject'] as const;

export class OpenDisputeDto {
  @ApiProperty({
    type: String,
    description:
      '`already_paid`, `wrong_amount`, `not_my_unit`, `service_not_provided`, `duplicate_invoice` or `other` (REASON_CODES.invoiceDispute).',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: DISPUTE_TEXT.min,
    maxLength: DISPUTE_TEXT.max,
    description:
      'The opener’s own words, trimmed. Shown to the opener and to the staff only; cleared when the opener is erased.',
  })
  @IsOptional()
  @IsString()
  @Length(DISPUTE_TEXT.min, DISPUTE_TEXT.max, withParams(DISPUTE_TEXT))
  text?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'A ready file of purpose `dispute_photo` the caller uploaded (POST /files).',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

/**
 * The staff's decision (ADR 0048): `accept` with the amount to credit (at
 * most what is owed now), or `reject` with a reason's code.
 */
export class DecideDisputeDto {
  @ApiProperty({ type: String, enum: DISPUTE_DECISIONS })
  @IsIn(DISPUTE_DECISIONS, withParams({ allowed: [...DISPUTE_DECISIONS] }))
  decision: (typeof DISPUTE_DECISIONS)[number];

  @ApiProperty({
    type: String,
    required: false,
    pattern: MONEY.source,
    description: 'On `accept` only: what to credit.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  amount?: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'On `reject` only: `charge_is_correct`, `payment_not_found`, `outside_policy`, `no_longer_owed` or `other` (REASON_CODES.invoiceDisputeReject).',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class StaffDisputesQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, type: String, enum: DISPUTE_STATUSES })
  @IsOptional()
  @IsIn(DISPUTE_STATUSES, withParams({ allowed: [...DISPUTE_STATUSES] }))
  status?: DisputeStatus;

  @ApiProperty({ required: false, type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}
