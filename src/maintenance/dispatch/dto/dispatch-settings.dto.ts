import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { MULTIPLIER, WEIGHT } from '../dispatch-settings.service';

const weight = withParams({ ...WEIGHT });
const multiplier = withParams({ ...MULTIPLIER });
const decimals = { maxDecimalPlaces: 2 };

export class UpdateDispatchSettingsDto {
  @ApiProperty({
    type: Boolean,
    required: false,
    description:
      'Assign tickets automatically. Off until the manager turns it on, after setting technicians’ specialties.',
  })
  @IsOptional()
  @IsBoolean()
  autoDispatchEnabled?: boolean;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: WEIGHT.min,
    maximum: WEIGHT.max,
    description: 'Weight of an assigned ticket in a technician’s workload.',
  })
  @IsOptional()
  @IsNumber(decimals, weight)
  @Min(WEIGHT.min, weight)
  @Max(WEIGHT.max, weight)
  weightAssigned?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: WEIGHT.min,
    maximum: WEIGHT.max,
    description: 'Weight of a ticket in progress.',
  })
  @IsOptional()
  @IsNumber(decimals, weight)
  @Min(WEIGHT.min, weight)
  @Max(WEIGHT.max, weight)
  weightInProgress?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: WEIGHT.min,
    maximum: WEIGHT.max,
    description: 'Weight of a ticket on hold (0: it takes no time now).',
  })
  @IsOptional()
  @IsNumber(decimals, weight)
  @Min(WEIGHT.min, weight)
  @Max(WEIGHT.max, weight)
  weightOnHold?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: MULTIPLIER.min,
    maximum: MULTIPLIER.max,
    description: 'Multiplies the weight of a normal-priority ticket.',
  })
  @IsOptional()
  @IsNumber(decimals, multiplier)
  @Min(MULTIPLIER.min, multiplier)
  @Max(MULTIPLIER.max, multiplier)
  multiplierNormal?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: MULTIPLIER.min,
    maximum: MULTIPLIER.max,
    description: 'Multiplies the weight of an urgent ticket.',
  })
  @IsOptional()
  @IsNumber(decimals, multiplier)
  @Min(MULTIPLIER.min, multiplier)
  @Max(MULTIPLIER.max, multiplier)
  multiplierUrgent?: number;

  @ApiProperty({
    type: Number,
    required: false,
    minimum: MULTIPLIER.min,
    maximum: MULTIPLIER.max,
    description: 'Multiplies the weight of an emergency.',
  })
  @IsOptional()
  @IsNumber(decimals, multiplier)
  @Min(MULTIPLIER.min, multiplier)
  @Max(MULTIPLIER.max, multiplier)
  multiplierEmergency?: number;
}
