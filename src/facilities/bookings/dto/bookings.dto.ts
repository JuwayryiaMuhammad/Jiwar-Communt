import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';

const GUESTS = { min: 0, max: 50 } as const;
export const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class CreateBookingDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  facilityId: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'The start of one of the facility’s slots, exactly (BOOKING_SLOT_NOT_OFFERED); not sooner than its `minMinutesBefore` (BOOKING_TOO_SOON) nor further than its `maxDaysAhead` (BOOKING_TOO_FAR).',
  })
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: GUESTS.min,
    maximum: GUESTS.max,
    description:
      'Guests beside the booker: a number, never names. At most the facility’s `maxGuests` (BOOKING_TOO_MANY_GUESTS). Default 0.',
  })
  @IsOptional()
  @IsInt(withParams(GUESTS))
  @Min(GUESTS.min, withParams(GUESTS))
  @Max(GUESTS.max, withParams(GUESTS))
  guests?: number;
}

export class CancelBookingDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `bookingResidentCancel`.',
  })
  @IsString()
  reasonCode: string;
}

export class FacilitySlotsQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    pattern: LOCAL_DATE.source,
    description: 'A local day of the compound, `YYYY-MM-DD`. Default today.',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  date?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'One of the caller’s units: each slot then says whether that unit holds it (`mine`).',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;
}

export class UnitBookingsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: ['upcoming', 'past'],
    required: false,
    default: 'upcoming',
    description:
      '`upcoming`: not over yet, soonest first. `past`: over, latest first.',
  })
  @IsOptional()
  @IsIn(['upcoming', 'past'])
  scope: 'upcoming' | 'past' = 'upcoming';
}
