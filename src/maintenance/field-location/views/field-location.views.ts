import { ApiProperty } from '@nestjs/swagger';
import {
  LOCATION_MOMENTS,
  type LastLocationRead,
  type LocationPoint,
  type OwnLocationRead,
} from '../field-location.service';

/** A point at one of a technician's steps on a ticket (ADR 0090). */
export class FieldLocationPointView {
  @ApiProperty({
    enum: LOCATION_MOMENTS,
    enumName: 'FieldLocationMoment',
    description:
      'On the way (`en_route`), at the door (`arrived`, a visit), or starting the work (`started`).',
  })
  moment: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: String, nullable: true, example: 'T-000123' })
  ticketNumber: string | null;
  @ApiProperty({ type: Number })
  latitude: number;
  @ApiProperty({ type: Number })
  longitude: number;
  @ApiProperty({ type: Number, nullable: true })
  accuracyMeters: number | null;
  @ApiProperty({ type: String, format: 'date-time' })
  capturedAt: string;

  static from(p: LocationPoint): FieldLocationPointView {
    return {
      moment: p.moment,
      ticketId: p.ticketId,
      ticketNumber: p.ticketNumber,
      latitude: p.latitude,
      longitude: p.longitude,
      accuracyMeters: p.accuracyMeters,
      capturedAt: p.capturedAt.toISOString(),
    };
  }
}

export class FieldLocationConsentView {
  @ApiProperty({ type: String, format: 'date-time' })
  grantedAt: string;
}

/** The technician's own consent and points of the 30 days. */
export class MyFieldLocationView {
  @ApiProperty({
    type: FieldLocationConsentView,
    nullable: true,
    description: 'Null: not consented, and no point is taken.',
  })
  consent: FieldLocationConsentView | null;
  @ApiProperty({
    type: [FieldLocationPointView],
    description: 'Newest first, 100 at most; kept 30 days.',
  })
  points: FieldLocationPointView[];

  static from(r: OwnLocationRead): MyFieldLocationView {
    return {
      consent: r.consent
        ? { grantedAt: r.consent.grantedAt.toISOString() }
        : null,
      points: r.points.map((p) => FieldLocationPointView.from(p)),
    };
  }
}

/** A technician's last known location, as the field team reads it. */
export class TechnicianLastLocationView {
  @ApiProperty({ type: String, format: 'uuid' })
  technicianId: string;
  @ApiProperty({ type: Boolean, description: 'Whether they consent now.' })
  consent: boolean;
  @ApiProperty({
    type: FieldLocationPointView,
    nullable: true,
    description:
      'Their latest point of the 30 days; null when none (no consent, or no step since).',
  })
  last: FieldLocationPointView | null;

  static from(r: LastLocationRead): TechnicianLastLocationView {
    return {
      technicianId: r.technicianId,
      consent: r.consent,
      last: r.last ? FieldLocationPointView.from(r.last) : null,
    };
  }
}
