import { ApiProperty } from '@nestjs/swagger';
import { ChildEscortKind } from '@prisma/client';
import { PostView, WeeklyScheduleView } from '../../roster/views/roster.views';

/** An escort as the household sees it (ADR 0054): never a code. */
export class ChildEscortView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ChildEscortKind, enumName: 'ChildEscortKind' })
  kind: ChildEscortKind;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  accountId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  engagementId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The adult's or the worker's name as the household knows it, or the outside person's; null once erased.",
  })
  name: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "An outside person's phone; null for the others.",
  })
  phone: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "An outside person's photo (a presigned URL), or null.",
  })
  photoUrl: string | null;
  @ApiProperty({ type: String, format: 'date', example: '2026-11-01' })
  validFrom: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  validUntil: string | null;
  @ApiProperty({ type: WeeklyScheduleView, nullable: true })
  schedule: WeeklyScheduleView | null;
  @ApiProperty({ type: PostView, nullable: true })
  post: PostView | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      "When an outside person's pickup code was issued last: an older one no longer works.",
  })
  pickupIssuedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** An outside person's pickup code, once: send them the link. */
export class PickupCodeView {
  @ApiProperty({ type: String, example: '042817' })
  code: string;
  @ApiProperty({
    type: String,
    example: 'JWP1.q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
  })
  qrPayload: string;
  @ApiProperty({
    type: String,
    example:
      'https://app.jiwar.example/c#q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
    description:
      'The token is in the fragment: no server ever receives it from the address.',
  })
  link: string;
}

/** An escort with its pickup code, once (no-store). */
export class ChildEscortSecretView extends ChildEscortView {
  @ApiProperty({
    type: PickupCodeView,
    nullable: true,
    description:
      'An outside person’s pickup code, once; null for the others, and on a replay once the escort is revoked.',
  })
  pickup: PickupCodeView | null;
}
