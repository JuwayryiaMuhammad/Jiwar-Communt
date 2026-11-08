import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

/**
 * Where the technician is, as the phone gave it (ADR 0090): degrees, six
 * decimals kept, and how sure in metres. Sent only with the technician's
 * consent; refused without it (LOCATION_CONSENT_REQUIRED).
 */
export class FieldLocationDto {
  @ApiProperty({ type: Number, minimum: -90, maximum: 90, example: 30.0444 })
  @IsNumber({ maxDecimalPlaces: 8, allowNaN: false, allowInfinity: false })
  @Min(-90, withParams({ min: -90 }))
  @Max(90, withParams({ max: 90 }))
  latitude: number;

  @ApiProperty({
    type: Number,
    minimum: -180,
    maximum: 180,
    example: 31.2357,
  })
  @IsNumber({ maxDecimalPlaces: 8, allowNaN: false, allowInfinity: false })
  @Min(-180, withParams({ min: -180 }))
  @Max(180, withParams({ max: 180 }))
  longitude: number;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0, withParams({ min: 0 }))
  @Max(10000, withParams({ max: 10000 }))
  accuracyMeters?: number;
}

/**
 * A technician's step on a ticket (on the way, at the door, starting the
 * work), with where they are when they consented to it (ADR 0090).
 */
export class TicketStepDto {
  @ApiPropertyOptional({
    type: FieldLocationDto,
    description:
      'Where I am now, only when I consented (409 LOCATION_CONSENT_REQUIRED otherwise: nothing moves). Never continuous: kept 30 days, and never shown to the residents.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => FieldLocationDto)
  location?: FieldLocationDto;
}
