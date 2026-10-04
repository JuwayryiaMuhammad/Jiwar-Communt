import { ApiProperty } from '@nestjs/swagger';
import { TechnicianAvailabilityState } from '@prisma/client';
import type { AvailabilityRead } from '../availability.service';

export class AvailabilityView {
  @ApiProperty({
    enum: TechnicianAvailabilityState,
    enumName: 'TechnicianAvailabilityState',
    description: 'A technician who never set it is `unavailable`.',
  })
  state: TechnicianAvailabilityState;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When it last changed; null if it never did.',
  })
  since: Date | null;

  static from(a: AvailabilityRead): AvailabilityView {
    return { state: a.state, since: a.since };
  }
}
