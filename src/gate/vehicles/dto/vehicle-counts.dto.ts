import { ApiProperty } from '@nestjs/swagger';
import { GateDirection } from '@prisma/client';
import { IsEnum, IsUUID } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';

export class CountVehicleDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A vehicle the plate lookup found (`matches[].vehicle`): registered, pending or active. Checked, never kept.',
  })
  @IsUUID()
  vehicleId: string;

  @ApiProperty({ enum: GateDirection, enumName: 'GateDirection' })
  @IsEnum(GateDirection, withParams({ allowed: Object.values(GateDirection) }))
  direction: GateDirection;
}
