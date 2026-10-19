import { ApiProperty } from '@nestjs/swagger';
import { ChildEscortKind, ChildPickupOutcome } from '@prisma/client';

/** The child, as the guard checking them sees them: a first name and a face. */
export class GateChildView {
  @ApiProperty({ type: String, example: 'Omar' })
  firstName: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "A presigned URL of the child's photo (minutes), or null: ask the escort.",
  })
  photoUrl: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Whether the child may leave alone.',
  })
  mayLeaveAlone: boolean;
}

/** Someone who may collect the child today, as the guard sees them. */
export class GateEscortView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ChildEscortKind, enumName: 'ChildEscortKind' })
  kind: ChildEscortKind;
  @ApiProperty({ type: String, nullable: true, example: 'Mona' })
  firstName: string | null;
  @ApiProperty({ type: String, nullable: true })
  photoUrl: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'Whether they may collect the child now and at this post: otherwise, at another hour or post today.',
  })
  validNow: boolean;
}

/** A scanned child card (ADR 0054): never a full name, a phone or a unit. */
export class ChildVerifyView {
  @ApiProperty({ enum: ['valid'] })
  result: 'valid';
  @ApiProperty({ type: GateChildView })
  child: GateChildView;
  @ApiProperty({ type: GateEscortView, isArray: true })
  escorts: GateEscortView[];
}

export class ExitEscortView {
  @ApiProperty({ enum: ChildEscortKind, enumName: 'ChildEscortKind' })
  kind: ChildEscortKind;
  @ApiProperty({ type: String, nullable: true })
  firstName: string | null;
}

/** An exit, as recorded (ADR 0054). */
export class ChildExitView {
  @ApiProperty({ type: String, format: 'uuid' })
  pickupId: string;
  @ApiProperty({
    enum: ['authorized', 'refused'],
    description: '`refused`: hold the child; the household has been alerted.',
  })
  result: 'authorized' | 'refused';
  @ApiProperty({ enum: ChildPickupOutcome, enumName: 'ChildPickupOutcome' })
  outcome: ChildPickupOutcome;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why it was refused: `not_an_escort`, `outside_validity`, `wrong_post`, `escort_inactive`, `no_credential`, `alone_not_allowed`, `lockdown` (an outside escort while the gate is locked down).',
  })
  reason: string | null;
  @ApiProperty({ type: ExitEscortView, nullable: true })
  escort: ExitEscortView | null;
}
