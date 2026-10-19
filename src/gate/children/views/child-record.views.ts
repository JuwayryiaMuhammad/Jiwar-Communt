import { ApiProperty } from '@nestjs/swagger';
import {
  ChildEscortKind,
  ChildPickupMethod,
  ChildPickupOutcome,
} from '@prisma/client';
import { FirstNameRefView } from '../../../core/common/http/personal';
import { PostView } from '../../roster/views/roster.views';
import { ExitEscortView } from './child-gate.views';

/** One of a child's exits, as the household reads it (ADR 0054). */
export class ChildPickupView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ type: String, example: 'Omar' })
  firstName: string;
  @ApiProperty({ enum: ChildPickupOutcome, enumName: 'ChildPickupOutcome' })
  outcome: ChildPickupOutcome;
  @ApiProperty({ enum: ChildPickupMethod, enumName: 'ChildPickupMethod' })
  method: ChildPickupMethod;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A refusal’s or an unverified release’s reason; offline (ADR 0057) also `escort_qr_invalid` (the adult’s QR did not verify at sync) and `offline_unverified` (an escort the device may not release offline).',
  })
  refusalReason: string | null;
  @ApiProperty({ type: ExitEscortView, nullable: true })
  escort: ExitEscortView | null;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
}

/**
 * An unauthorized pickup, as the roster's keepers read it (ADR 0054): when,
 * where, which guard, which unit and how the person was known. Never the
 * child, a member id or an escort's name.
 */
export class ChildAlertView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
  @ApiProperty({ type: PostView })
  post: PostView;
  @ApiProperty({ type: FirstNameRefView })
  guard: FirstNameRefView;
  @ApiProperty({ type: String, example: 'A-101' })
  unitCode: string;
  @ApiProperty({
    enum: ChildPickupOutcome,
    enumName: 'ChildPickupOutcome',
    description:
      '`refused` at the gate, or `left_unverified`: released offline with an escort or leave the server could not verify at sync (ADR 0057).',
  })
  outcome: ChildPickupOutcome;
  @ApiProperty({ enum: ChildPickupMethod, enumName: 'ChildPickupMethod' })
  method: ChildPickupMethod;
  @ApiProperty({
    enum: ChildEscortKind,
    enumName: 'ChildEscortKind',
    nullable: true,
  })
  escortKind: ChildEscortKind | null;
  @ApiProperty({ type: String, nullable: true })
  refusalReason: string | null;
}
