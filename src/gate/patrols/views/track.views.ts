import { ApiProperty } from '@nestjs/swagger';
import type { PatrolTrackPoint } from '@prisma/client';

/** Where the guard was, at an instant of the run (ADR 0052). */
export class TrackPointView {
  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt: Date;
  @ApiProperty({ type: Number })
  lat: number;
  @ApiProperty({ type: Number })
  lng: number;
  @ApiProperty({ type: Number, nullable: true })
  accuracyM: number | null;

  static of(p: PatrolTrackPoint): TrackPointView {
    return {
      recordedAt: p.recordedAt,
      lat: p.lat,
      lng: p.lng,
      accuracyM: p.accuracyM,
    };
  }
}

export class TrackAcceptedView {
  @ApiProperty({
    type: Number,
    description: 'Points recorded now; those sent before are not counted.',
  })
  accepted: number;
  @ApiProperty({
    type: Number,
    description:
      'Points dropped: outside the run’s lifetime, two minutes either side. Do not send them again.',
  })
  rejected: number;
}
