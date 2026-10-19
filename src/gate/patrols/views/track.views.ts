import { ApiProperty } from '@nestjs/swagger';
import type { PatrolGeofenceExit, PatrolTrackPoint } from '@prisma/client';

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

/** A time the guard was outside the route's geofence (ADR 0056): times only. */
export class GeofenceExitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'The device’s time of the first point outside.',
  })
  leftAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'The device’s time of the next point inside; null: not back yet, or not known.',
  })
  backAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When it was flagged to `patrols.manage`: it lasted the threshold. Once.',
  })
  flaggedAt: Date | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The threshold it passed, in minutes.',
  })
  flaggedMinutes: number | null;

  static of(e: PatrolGeofenceExit): GeofenceExitView {
    return {
      id: e.id,
      leftAt: e.leftAt,
      backAt: e.backAt,
      flaggedAt: e.flaggedAt,
      flaggedMinutes: e.flaggedMinutes,
    };
  }
}
