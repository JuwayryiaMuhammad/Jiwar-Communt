import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { ACCURACY_M, LATITUDE, LONGITUDE, TRACK_BATCH } from '../patrol-rules';
import { ToInstant } from '../../../core/common/validation/instant';

const decimals = { maxDecimalPlaces: 7 };

export class TrackPointDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'The device’s time: inside the run’s lifetime, two minutes either side.',
  })
  @ToInstant()
  @IsDate()
  recordedAt: Date;

  @ApiProperty({ type: Number, minimum: LATITUDE.min, maximum: LATITUDE.max })
  @IsNumber(decimals, withParams({ ...LATITUDE }))
  @Min(LATITUDE.min, withParams({ ...LATITUDE }))
  @Max(LATITUDE.max, withParams({ ...LATITUDE }))
  lat: number;

  @ApiProperty({
    type: Number,
    minimum: LONGITUDE.min,
    maximum: LONGITUDE.max,
  })
  @IsNumber(decimals, withParams({ ...LONGITUDE }))
  @Min(LONGITUDE.min, withParams({ ...LONGITUDE }))
  @Max(LONGITUDE.max, withParams({ ...LONGITUDE }))
  lng: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: ACCURACY_M.min,
    maximum: ACCURACY_M.max,
  })
  @IsOptional()
  @IsNumber({}, withParams({ ...ACCURACY_M }))
  @Min(ACCURACY_M.min, withParams({ ...ACCURACY_M }))
  @Max(ACCURACY_M.max, withParams({ ...ACCURACY_M }))
  accuracyM?: number;
}

export class TrackDto {
  @ApiProperty({
    type: [TrackPointDto],
    minItems: TRACK_BATCH.min,
    maxItems: TRACK_BATCH.max,
    description:
      'A point at an instant already recorded for the run is ignored: a batch sent again adds nothing.',
  })
  @IsArray()
  @ArrayMinSize(TRACK_BATCH.min, withParams({ ...TRACK_BATCH }))
  @ArrayMaxSize(TRACK_BATCH.max, withParams({ ...TRACK_BATCH }))
  @ValidateNested({ each: true })
  @Type(() => TrackPointDto)
  points: TrackPointDto[];
}
