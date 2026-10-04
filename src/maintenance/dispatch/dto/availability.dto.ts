import { ApiProperty } from '@nestjs/swagger';
import { TechnicianAvailabilityState } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

const STATES = withParams({
  allowed: Object.values(TechnicianAvailabilityState),
});

/** The technician's own change: no reason. */
export class SetAvailabilityDto {
  @ApiProperty({
    enum: TechnicianAvailabilityState,
    enumName: 'TechnicianAvailabilityState',
  })
  @IsEnum(TechnicianAvailabilityState, STATES)
  state: TechnicianAvailabilityState;
}

/** A dispatcher's change: with a reason code. */
export class SetTechnicianAvailabilityDto extends SetAvailabilityDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `availabilityChange`.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}
