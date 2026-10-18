import { ApiProperty } from '@nestjs/swagger';
import type { ChildControl } from '@prisma/client';

/** A child's exit control as the household sees it (ADR 0054): never its card. */
export class ChildControlView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: Boolean,
    description:
      'Whether the child may leave the compound alone: otherwise a guard holds them and the household is alerted.',
  })
  mayLeaveAlone: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      'Whether the household is told of each exit (`child.picked_up`). Alerts are sent whatever this says.',
  })
  notifyPickups: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When the card was printed last: an older card no longer scans.',
  })
  cardIssuedAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "A presigned URL of the child's photo (minutes), or null: the guard asks the escort when there is none.",
  })
  photoUrl: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  turnedOnAt: Date;

  static of(c: ChildControl, photoUrl: string | null): ChildControlView {
    return {
      id: c.id,
      mayLeaveAlone: c.mayLeaveAlone,
      notifyPickups: c.notifyPickups,
      // Live controls always have one (child_controls_card_while_live).
      cardIssuedAt: c.cardIssuedAt!,
      photoUrl,
      turnedOnAt: c.turnedOnAt,
    };
  }
}

/** What the child's card shows: printed once, at turn-on and at a reissue. */
export class ChildCardView {
  @ApiProperty({
    type: String,
    example: 'JWC1.q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek',
    description:
      'For the QR: `JWC1.<token>`. Shown once; a reissue prints a new one and the old card stops scanning.',
  })
  qrPayload: string;
  @ApiProperty({ type: String, example: 'Omar' })
  firstName: string;
  @ApiProperty({ type: String, example: 'A-101' })
  unitCode: string;
  @ApiProperty({ type: String })
  compoundName: string;
}

/** A control with its card, once (no-store). */
export class ChildControlSecretView extends ChildControlView {
  @ApiProperty({
    type: ChildCardView,
    nullable: true,
    description:
      'The card, once. Null only on a replay (same `Idempotency-Key`) after the control has ended.',
  })
  card: ChildCardView | null;
}

/** One of the unit's minors, and their exit control if it is on. */
export class ChildView {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ type: String, example: 'Omar' })
  firstName: string;
  @ApiProperty({ type: String, example: 'Omar Ahmed Hassan' })
  fullName: string;
  @ApiProperty({
    type: Number,
    example: 9,
    description: "Years, on the compound's day.",
  })
  age: number;
  @ApiProperty({ type: ChildControlView, nullable: true })
  control: ChildControlView | null;
}
