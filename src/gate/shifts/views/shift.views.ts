import { ApiProperty } from '@nestjs/swagger';
import type { ShiftRecord } from '../shifts.service';

export class ShiftView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'uuid' })
  gateId: string;

  @ApiProperty({ type: String })
  gateName: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  static from(s: ShiftRecord): ShiftView {
    return {
      id: s.id,
      gateId: s.gateId,
      gateName: s.gateName,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    };
  }
}
