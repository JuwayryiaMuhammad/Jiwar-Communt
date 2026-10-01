import { ApiProperty } from '@nestjs/swagger';
import { GateRequestKind } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const PARTY = { min: 1, max: 50 };

/**
 * One body for the three kinds; the service checks which fields each needs
 * (a unit code for visitors and deliveries, an engagement for a worker).
 */
export class CreateGateRequestDto {
  @ApiProperty({ enum: GateRequestKind, enumName: 'GateRequestKind' })
  @IsEnum(
    GateRequestKind,
    withParams({ allowed: Object.values(GateRequestKind) }),
  )
  kind: GateRequestKind;

  @ApiProperty({
    type: String,
    required: false,
    description: 'Visitors and deliveries: the unit they came for.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  unitCode?: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: PARTY.min,
    maximum: PARTY.max,
    default: 1,
  })
  @IsOptional()
  @IsInt(withParams(PARTY))
  @Min(PARTY.min, withParams(PARTY))
  @Max(PARTY.max, withParams(PARTY))
  partySize?: number;

  @ApiProperty({
    type: String,
    required: false,
    description: 'As the visitor gives it; shown to the household only.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  visitorName?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'worker_off_schedule: the engagement verify returned.',
  })
  @IsOptional()
  @IsUUID()
  engagementId?: string;
}

const DECISIONS = ['approve', 'deny'] as const;

export class DecideDto {
  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS, withParams({ allowed: [...DECISIONS] }))
  decision: (typeof DECISIONS)[number];
}
