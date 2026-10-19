import { ApiProperty } from '@nestjs/swagger';

/** A counted passage: nothing of the vehicle, the day or the gate. */
export class VehicleCountedView {
  @ApiProperty({ type: Boolean, enum: [true] })
  counted: true;
}
