import { ApiProperty } from '@nestjs/swagger';
import { IsDate, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ToInstant } from '../../../core/common/validation/instant';
import { withParams } from '../../../core/common/validation/validation-errors';
import { GUESTS } from '../../bookings/dto/bookings.dto';

/** ADR 0070: a full slot waited for, for a unit. */
export class JoinWaitlistDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A unit the caller books for.',
  })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'The slot’s start, with an offset; a full slot of the facility’s, at least 15 minutes ahead.',
  })
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: GUESTS.min,
    maximum: GUESTS.max,
    description: 'Guests the booking would take. Default 0.',
  })
  @IsOptional()
  @IsInt(withParams(GUESTS))
  @Min(GUESTS.min, withParams(GUESTS))
  @Max(GUESTS.max, withParams(GUESTS))
  guests?: number;
}
