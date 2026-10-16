import { ApiProperty } from '@nestjs/swagger';
import { PlaceView } from '../../places/views/place.views';
import type { ShiftRecord } from '../shifts.service';

export class ShiftView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null for a shift in a zone.',
  })
  gateId: string | null;

  @ApiProperty({ type: String, nullable: true })
  gateName: string | null;

  @ApiProperty({
    type: PlaceView,
    nullable: true,
    description:
      'The zone, for a shift that is not at a gate (ADR 0050); the gate actions refuse it.',
  })
  zone: PlaceView | null;

  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  static from(s: ShiftRecord): ShiftView {
    return {
      id: s.id,
      gateId: s.gateId,
      gateName: s.gateName,
      zone: s.zone,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    };
  }
}
