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
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { RECEIPT } from '../../fines/fine-rules';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';
import { AMOUNT, APPEAL_TEXT, NOTE } from '../violations.service';

const KINDS = REASON_CODES.violationKind;
const STATUSES = ['open', 'under_appeal', 'paid', 'cancelled'] as const;

export class IssueViolationDto {
  @ApiProperty({ enum: KINDS, enumName: 'ViolationKind' })
  @IsIn(KINDS, withParams({ allowed: [...KINDS] }))
  kind: (typeof KINDS)[number];

  @ApiProperty({
    type: String,
    required: false,
    description:
      'The unit’s code (UNIT_CODE_UNKNOWN). Contractor hours may give the works permit instead.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      '`contractor_hours` only: the unit’s works permit; the unit is the permit’s.',
  })
  @IsOptional()
  @IsUUID()
  permitId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'Where: a place in service.',
  })
  @IsOptional()
  @IsUUID()
  placeId?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: NOTE.min,
    maxLength: NOTE.max,
    description: 'What the unit’s people read.',
  })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: AMOUNT.source,
    description: 'EGP, at most 100,000. None: a warning, never paid.',
  })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT)
  amount?: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The local day it happened: not ahead, at most 90 days ago (DAY_OUT_OF_RANGE).',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  occurredOn: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A finalized `violation_photo` upload of the caller.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

export class StaffViolationsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: STATUSES,
    required: false,
    description:
      '`under_appeal` is the appeals queue, oldest first; anything else newest first.',
  })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];

  @ApiProperty({ enum: KINDS, required: false })
  @IsOptional()
  @IsIn(KINDS, withParams({ allowed: [...KINDS] }))
  kind?: (typeof KINDS)[number];

  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;
}

export class UnitViolationsQueryDto extends PageQueryDto {
  @ApiProperty({ enum: STATUSES, required: false })
  @IsOptional()
  @IsIn(STATUSES, withParams({ allowed: [...STATUSES] }))
  status?: (typeof STATUSES)[number];
}

export class DecideViolationAppealDto {
  @ApiProperty({
    enum: ['upheld', 'cancelled'],
    description: '`upheld`: open again. `cancelled`: it is cancelled.',
  })
  @IsIn(
    ['upheld', 'cancelled'],
    withParams({ allowed: ['upheld', 'cancelled'] }),
  )
  decision: 'upheld' | 'cancelled';

  @ApiProperty({
    type: String,
    required: false,
    description:
      'With `cancelled` only, from `violationCancel` (default `appeal_accepted`).',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class CancelViolationDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `violationCancel`.',
  })
  @IsString()
  reasonCode: string;
}

export class AppealViolationDto {
  @ApiProperty({
    type: String,
    minLength: APPEAL_TEXT.min,
    maxLength: APPEAL_TEXT.max,
    description: 'Why: the appellant’s words.',
  })
  @IsString()
  reason: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A finalized `violation_appeal_photo` upload of the caller.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

export class RecordViolationPaymentDto {
  @ApiProperty({
    type: String,
    pattern: AMOUNT.source,
    description:
      'The whole amount of the violation (AMOUNT_MISMATCH, params.amount).',
  })
  @IsString()
  @Matches(AMOUNT)
  amount: string;

  @ApiProperty({ type: String, required: false, enum: ['EGP'], default: 'EGP' })
  @IsOptional()
  @IsIn(['EGP'])
  currency?: string;

  @ApiProperty({
    type: String,
    pattern: RECEIPT.source,
    description:
      'Once among the compound’s violation payments (DUPLICATE_RESOURCE).',
  })
  @IsString()
  @Matches(RECEIPT)
  receiptNumber: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The local day it was paid: not ahead, at most 90 days ago, not before the violation’s day (PAID_ON_OUT_OF_RANGE).',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  paidOn: string;
}

export class ReverseViolationPaymentDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `violationPaymentReverse`.',
  })
  @IsString()
  reasonCode: string;
}
