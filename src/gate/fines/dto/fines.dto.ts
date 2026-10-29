import { ApiProperty } from '@nestjs/swagger';
import { VehicleFineStatus } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { PLATE_MAX } from '../../../core/common/vehicle-plate';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import { APPEAL_TEXT, FINE_AMOUNT, NOTE, RECEIPT } from '../fine-rules';

export class IssueFineDto {
  @ApiProperty({
    type: String,
    description: 'The unit’s code (UNIT_CODE_UNKNOWN).',
  })
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'One of the unit’s vehicles, not removed (VEHICLE_NOT_OF_UNIT); its plate is taken. Otherwise give `plate`.',
  })
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: PLATE_MAX,
    description: 'Without a vehicle: the plate as read.',
  })
  @IsOptional()
  @IsString()
  plate?: string;

  @ApiProperty({
    type: String,
    description: 'From the closed list `vehicleFineReason`.',
  })
  @IsString()
  reason: string;

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
    pattern: FINE_AMOUNT.source,
    description: 'EGP, e.g. `500` or `500.50`; at most 100,000.',
  })
  @IsString()
  @Matches(FINE_AMOUNT)
  amount: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The local day it happened: not ahead, at most 90 days ago (DAY_OUT_OF_RANGE).',
  })
  @IsString()
  @IsLocalDate()
  occurredOn: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A finalized `vehicle_fine_photo` upload of the caller.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

export class StaffFinesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: VehicleFineStatus,
    enumName: 'VehicleFineStatus',
    required: false,
    description:
      '`under_appeal` is the appeals queue, oldest first; anything else newest first.',
  })
  @IsOptional()
  @IsEnum(
    VehicleFineStatus,
    withParams({ allowed: Object.values(VehicleFineStatus) }),
  )
  status?: VehicleFineStatus;

  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;
}

export class DecideAppealDto {
  @ApiProperty({
    enum: ['upheld', 'cancelled'],
    description:
      '`upheld`: the fine is unpaid again. `cancelled`: it is cancelled.',
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
      'With `cancelled` only, from `vehicleFineCancel` (default `appeal_accepted`).',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class CancelFineDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `vehicleFineCancel`.',
  })
  @IsString()
  reasonCode: string;
}

const RESIDENT_FILTERS = ['unpaid', 'paid', 'cancelled'] as const;

export class UnitFinesQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: RESIDENT_FILTERS,
    required: false,
    description: '`unpaid` includes what is under appeal. Absent: every fine.',
  })
  @IsOptional()
  @IsIn(RESIDENT_FILTERS, withParams({ allowed: [...RESIDENT_FILTERS] }))
  status?: (typeof RESIDENT_FILTERS)[number];
}

export class AppealFineDto {
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
    description: 'A finalized `parking_photo` upload of the caller.',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

export class RecordFinePaymentDto {
  @ApiProperty({
    type: String,
    pattern: FINE_AMOUNT.source,
    description:
      'The whole amount of the fine (AMOUNT_MISMATCH, params.amount).',
  })
  @IsString()
  @Matches(FINE_AMOUNT)
  amount: string;

  @ApiProperty({ type: String, required: false, enum: ['EGP'], default: 'EGP' })
  @IsOptional()
  @IsIn(['EGP'])
  currency?: string;

  @ApiProperty({
    type: String,
    pattern: RECEIPT.source,
    description:
      'Once among the compound’s fine payments (DUPLICATE_RESOURCE).',
  })
  @IsString()
  @Matches(RECEIPT)
  receiptNumber: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The local day it was paid: not ahead, at most 90 days ago, not before the fine’s day (PAID_ON_OUT_OF_RANGE).',
  })
  @IsString()
  @IsLocalDate()
  paidOn: string;
}

export class ReverseFinePaymentDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `vehicleFinePaymentReverse`.',
  })
  @IsString()
  reasonCode: string;
}
