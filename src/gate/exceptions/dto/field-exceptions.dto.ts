import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import {
  EXCEPTION_KINDS,
  VISITOR_NAME_MAX,
  type ExceptionKind,
  type ExceptionWorkerType,
} from '../field-exception-rules';

const WORKER_TYPES = ['worker_engagement', 'permit_worker'] as const;

export class ExceptionWorkerDto {
  @ApiProperty({
    enum: WORKER_TYPES,
    description:
      'A household’s worker (its engagement) or a works permit’s contractor worker.',
  })
  @IsIn(WORKER_TYPES, withParams({ allowed: [...WORKER_TYPES] }))
  type: ExceptionWorkerType;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  id: string;
}

/**
 * One body for the three kinds; the service checks what each needs: a
 * worker for `worker_outside_hours`; a unit for a visitor and a vehicle,
 * and a plate for a vehicle.
 */
export class RaiseFieldExceptionDto {
  @ApiProperty({ enum: EXCEPTION_KINDS, enumName: 'GateExceptionKind' })
  @IsIn(EXCEPTION_KINDS, withParams({ allowed: [...EXCEPTION_KINDS] }))
  kind: ExceptionKind;

  @ApiProperty({
    enum: [...REASON_CODES.gateExceptionRaise],
    description:
      'Why the guard asks, from the closed list `gateExceptionRaise`.',
  })
  @IsString()
  reasonCode: string;

  @ApiProperty({
    type: String,
    required: false,
    description: 'A visitor’s or a vehicle’s: the unit they came for.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;

  @ApiProperty({ type: ExceptionWorkerDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExceptionWorkerDto)
  worker?: ExceptionWorkerDto;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: VISITOR_NAME_MAX,
    description:
      'As the visitor gives it: shown to the management deciding, kept 30 days, never in a notification.',
  })
  @IsOptional()
  @IsString()
  @Length(1, VISITOR_NAME_MAX, withParams({ min: 1, max: VISITOR_NAME_MAX }))
  visitorName?: string;

  @ApiProperty({
    type: String,
    required: false,
    example: 'ق ب ط 1234',
    description:
      'Required for `unregistered_vehicle`, optional for a visitor’s car. Kept 30 days and matched against the blocklist.',
  })
  @IsOptional()
  @IsString()
  vehiclePlate?: string;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'The full ID number on the card they show: matched against the blocklist, never stored, nor kept in the idempotency record.',
  })
  @IsOptional()
  @IsString()
  idNumber?: string;
}

const DECISIONS = ['approve', 'reject'] as const;

export class DecideFieldExceptionDto {
  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS, withParams({ allowed: [...DECISIONS] }))
  decision: (typeof DECISIONS)[number];

  @ApiProperty({
    enum: [...REASON_CODES.gateExceptionReject],
    required: false,
    description:
      'A rejection’s, from the closed list `gateExceptionReject` (required then); never with an approval.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

const FILTERS = ['pending', 'decided', 'all'] as const;

export class FieldExceptionsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: FILTERS,
    required: false,
    default: 'all',
    description:
      '`pending`: what may still be answered now; `decided`: answered, expired or withdrawn.',
  })
  @IsOptional()
  @IsIn(FILTERS, withParams({ allowed: [...FILTERS] }))
  status?: (typeof FILTERS)[number];
}
