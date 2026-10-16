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

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'The start of the roster slot this shift filled (ADR 0050); null for an unscheduled shift.',
  })
  scheduledStart: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledEnd: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Minutes after the slot’s start the shift opened; more than ten is late. Null for an unscheduled shift.',
  })
  lateMinutes: number | null;

  @ApiProperty({
    type: Number,
    description:
      'While open: handovers at this post nobody acknowledged, of the last day (`GET /gate/handovers/pending`).',
  })
  pendingHandovers: number;

  static from(s: ShiftRecord): ShiftView {
    return {
      id: s.id,
      gateId: s.gateId,
      gateName: s.gateName,
      zone: s.zone,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      scheduledStart: s.slot?.startsAt ?? null,
      scheduledEnd: s.slot?.endsAt ?? null,
      lateMinutes: s.slot?.lateMinutes ?? null,
      pendingHandovers: s.pendingHandovers,
    };
  }
}
