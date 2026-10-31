import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import {
  IsLocalDate,
  LOCAL_DATE,
} from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';
import { GUESTS } from '../../bookings/dto/bookings.dto';

/** ADR 0070: nights in a stay facility, for a unit. */
export class CreateStayDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A stay facility.',
  })
  @IsUUID()
  facilityId: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description: 'The first night, a local day `YYYY-MM-DD`.',
  })
  @IsString()
  @IsLocalDate()
  fromOn: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    description:
      'The check-out day, after the last night: 1 to the facility’s `maxNights` nights (STAY_TOO_LONG).',
  })
  @IsString()
  @IsLocalDate()
  toOn: string;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: GUESTS.min,
    maximum: GUESTS.max,
    description: 'Guests beside the booker. Default 0.',
  })
  @IsOptional()
  @IsInt(withParams(GUESTS))
  @Min(GUESTS.min, withParams(GUESTS))
  @Max(GUESTS.max, withParams(GUESTS))
  guests?: number;
}
