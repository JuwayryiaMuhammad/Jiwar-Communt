import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  COMPLAINT_OUTCOMES,
  type ComplaintOutcome,
} from '../complaints.service';

const STARS = { min: 1, max: 5 } as const;
const COMMENT = { min: 1, max: 500 } as const;
const MESSAGE = { min: 1, max: 4000 } as const;
/** EGP above nothing, two decimals at most, below a million. */
const AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,6}(\.\d{1,2})?$/;
const BOOLEAN = ['true', 'false'] as const;

export class RatePartnerRequestDto {
  @ApiProperty({ type: Number, minimum: STARS.min, maximum: STARS.max })
  @IsInt(withParams(STARS))
  @Min(STARS.min, withParams(STARS))
  @Max(STARS.max, withParams(STARS))
  stars: number;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    minLength: COMMENT.min,
    maxLength: COMMENT.max,
    description: 'Read by the management alone; never by the partner.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(COMMENT.min, COMMENT.max, withParams(COMMENT))
  comment?: string | null;
}

export class ComplainPartnerRequestDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `partnerComplaint`.',
  })
  @IsString()
  reason: string;

  @ApiProperty({
    type: String,
    description: 'From the closed list `partnerCompensationAsk`.',
  })
  @IsString()
  compensationAsk: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    pattern: AMOUNT.source,
    description:
      'EGP, with a refund or damages asked only (PARTNER_AMOUNT_NOT_ASKED).',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(AMOUNT)
  requestedAmount?: string | null;

  @ApiProperty({
    type: String,
    minLength: MESSAGE.min,
    maxLength: MESSAGE.max,
    description:
      'The first message of the management request the complaint is.',
  })
  @IsString()
  @Length(MESSAGE.min, MESSAGE.max, withParams(MESSAGE))
  message: string;
}

export class DecideComplaintDto {
  @ApiProperty({
    enum: COMPLAINT_OUTCOMES,
    enumName: 'PartnerComplaintOutcome',
  })
  @IsIn(COMPLAINT_OUTCOMES, withParams({ allowed: [...COMPLAINT_OUTCOMES] }))
  outcome: ComplaintOutcome;

  @ApiProperty({
    type: String,
    description:
      'From the closed list `partnerCompensationDecision`; `none` when not upheld.',
  })
  @IsString()
  compensation: string;
}

export class PartnerComplaintsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description: '`false`: those waiting for a decision.',
  })
  @IsOptional()
  @IsIn(BOOLEAN, withParams({ allowed: [...BOOLEAN] }))
  decided?: 'true' | 'false';

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  partnerId?: string;
}

export class RatingsQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  partnerId?: string;
}
