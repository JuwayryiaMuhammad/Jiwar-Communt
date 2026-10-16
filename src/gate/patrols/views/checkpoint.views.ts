import { ApiProperty } from '@nestjs/swagger';
import type { PatrolCheckpoint } from '@prisma/client';
import type { DutyNames } from '../../roster/duty-names';
import { PostView } from '../../roster/views/roster.views';

export class CheckpointPositionView {
  @ApiProperty({ type: Number, example: 30.0444 })
  lat: number;
  @ApiProperty({ type: Number, example: 31.2357 })
  lng: number;
  @ApiProperty({
    type: Number,
    description: 'Metres: a scan farther away is flagged.',
  })
  radiusM: number;

  static of(c: PatrolCheckpoint): CheckpointPositionView | null {
    return c.lat !== null && c.lng !== null && c.radiusM !== null
      ? { lat: c.lat, lng: c.lng, radiusM: c.radiusM }
      : null;
  }
}

/** A checkpoint as the management keeps it (ADR 0052): never its token. */
export class CheckpointView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({ type: String, example: 'Pool gate' })
  nameEn: string;
  @ApiProperty({ type: String, example: 'بوابة المسبح' })
  nameAr: string;
  @ApiProperty({ type: CheckpointPositionView, nullable: true })
  position: CheckpointPositionView | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When its QR was printed last: an older printout no longer scans.',
  })
  tokenIssuedAt: Date;
  @ApiProperty({
    type: Number,
    description:
      'How many routes in service walk it now: it is retired only at 0.',
  })
  routes: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static of(
    c: PatrolCheckpoint,
    names: DutyNames,
    routes: number,
  ): CheckpointView {
    return {
      id: c.id,
      post: PostView.of(c, names),
      nameEn: c.nameEn,
      nameAr: c.nameAr,
      position: CheckpointPositionView.of(c),
      tokenIssuedAt: c.tokenIssuedAt,
      routes,
      retiredAt: c.retiredAt,
      createdAt: c.createdAt,
    };
  }
}

/** A checkpoint with its QR payload: shown once, at creation and at a reissue. */
export class CheckpointSecretView extends CheckpointView {
  @ApiProperty({
    type: String,
    example:
      'JWK1.0199c3d2-6f1a-7c3e-9a51-3b2f6e8d1c40.q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
    description:
      'For the QR and the NFC tag: `JWK1.<checkpointId>.<token>`. Shown once; a reissue prints a new one and the old one stops scanning.',
  })
  qrPayload: string;
}
