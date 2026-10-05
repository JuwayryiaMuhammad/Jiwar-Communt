import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { RESOLUTION_MINUTES, RESPONSE_MINUTES } from '../sla-targets.service';

const response = withParams({ ...RESPONSE_MINUTES });
const resolution = withParams({ ...RESOLUTION_MINUTES });

export class UpdateSlaSettingsDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Measure response and resolution times. Off until the manager turns it on; turning it on starts clocks for the open tickets from that moment, never earlier.',
  })
  @IsOptional()
  @IsBoolean()
  slaEnabled?: boolean;
}

export class SlaTargetDto {
  @ApiProperty({
    type: Number,
    minimum: RESPONSE_MINUTES.min,
    maximum: RESPONSE_MINUTES.max,
    description:
      'Minutes from opening to the first visit proposal or the start of the work.',
  })
  @IsInt(response)
  @Min(RESPONSE_MINUTES.min, response)
  @Max(RESPONSE_MINUTES.max, response)
  responseMinutes: number;

  @ApiProperty({
    type: Number,
    minimum: RESOLUTION_MINUTES.min,
    maximum: RESOLUTION_MINUTES.max,
    description:
      'Minutes from opening until the technician reports the work done, without the time spent waiting for the resident or for parts. At least the response target.',
  })
  @IsInt(resolution)
  @Min(RESOLUTION_MINUTES.min, resolution)
  @Max(RESOLUTION_MINUTES.max, resolution)
  resolutionMinutes: number;
}

/** A category's three targets, one per priority: the whole set. */
export class SlaTargetsDto {
  @ApiProperty({ type: SlaTargetDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SlaTargetDto)
  emergency: SlaTargetDto;

  @ApiProperty({ type: SlaTargetDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SlaTargetDto)
  urgent: SlaTargetDto;

  @ApiProperty({ type: SlaTargetDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => SlaTargetDto)
  normal: SlaTargetDto;
}
