import { ApiProperty } from '@nestjs/swagger';
import type {
  GuardInstruction,
  GuardInstructionRecipient,
} from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import type { DutyNames } from '../../roster/duty-names';
import {
  dayOf,
  INSTRUCTION_STATES,
  instructionState,
  type InstructionState,
} from '../instruction-validity';
import { PostView } from '../../roster/views/roster.views';

export interface InstructionCounts {
  recipients: number;
  acknowledged: number;
}

class GuardInstructionBodyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String })
  body: string;
  @ApiProperty({ type: Boolean, description: 'Sent as a critical push.' })
  urgent: boolean;
  @ApiProperty({
    enum: ['all', 'gate', 'zone'],
    enumName: 'GuardInstructionAudience',
  })
  audience: string;
  @ApiProperty({
    type: PostView,
    nullable: true,
    description: 'The gate or the zone; null for all guards.',
  })
  post: PostView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'It reaches nobody new once archived.',
  })
  archivedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-12-20',
    description:
      'The compound day it holds from, inclusive (ADR 0056); null: from its sending.',
  })
  validFrom: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2027-01-05',
    description:
      'The compound day it holds until, inclusive; null: until archived.',
  })
  validUntil: string | null;
}

function body(i: GuardInstruction, names: DutyNames): GuardInstructionBodyView {
  return {
    id: i.id,
    title: i.title,
    body: i.body,
    urgent: i.urgent,
    audience: i.audience,
    post: i.gateId || i.placeId ? PostView.of(i, names) : null,
    createdAt: i.createdAt,
    archivedAt: i.archivedAt,
    validFrom: i.validFrom ? dayOf(i.validFrom) : null,
    validUntil: i.validUntil ? dayOf(i.validUntil) : null,
  };
}

/** An instruction as a guard it reaches reads it. */
export class MyGuardInstructionView extends GuardInstructionBodyView {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When I acknowledged it; null while it waits for me.',
  })
  acknowledgedAt: Date | null;

  static from(
    i: GuardInstruction,
    names: DutyNames,
    acknowledgedAt: Date | null,
  ): MyGuardInstructionView {
    return { ...body(i, names), acknowledgedAt };
  }
}

/** An instruction as the management reads it: who sent it, the counts. */
export class StaffGuardInstructionView extends GuardInstructionBodyView {
  @ApiProperty({ type: AccountRefView })
  createdBy: AccountRefView;
  @ApiProperty({ type: Number, description: 'The guards it reaches.' })
  recipients: number;
  @ApiProperty({
    type: Number,
    description: 'Of them, those who acknowledged.',
  })
  acknowledged: number;
  @ApiProperty({
    enum: INSTRUCTION_STATES,
    enumName: 'GuardInstructionState',
    description:
      'Today, in the compound’s calendar: not yet valid, valid (guards see it), past its last day, or archived (ADR 0056).',
  })
  state: InstructionState;

  static of(
    i: GuardInstruction,
    names: DutyNames,
    counts: Map<string, InstructionCounts>,
    today: string,
  ): StaffGuardInstructionView {
    const c = counts.get(i.id);
    return {
      ...body(i, names),
      state: instructionState(i, today),
      createdBy: accountRef(names.people.get(i.createdById)!),
      recipients: c?.recipients ?? 0,
      acknowledged: c?.acknowledged ?? 0,
    };
  }
}

export class InstructionRecipientView {
  @ApiProperty({ type: AccountRefView })
  guard: AccountRefView;
  @ApiProperty({
    enum: ['send', 'shift_start'],
    enumName: 'GuardInstructionVia',
    description: 'Reached at the send, or opening a shift where it applies.',
  })
  addedVia: string;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acknowledgedAt: Date | null;
}

export class StaffGuardInstructionDetailView extends StaffGuardInstructionView {
  @ApiProperty({ type: [InstructionRecipientView] })
  reached: InstructionRecipientView[];

  static detail(
    view: StaffGuardInstructionView,
    recipients: readonly GuardInstructionRecipient[],
    names: DutyNames,
  ): StaffGuardInstructionDetailView {
    return {
      ...view,
      reached: recipients.map((r) => ({
        guard: accountRef(names.people.get(r.accountId)!),
        addedVia: r.addedVia,
        addedAt: r.addedAt,
        acknowledgedAt: r.acknowledgedAt,
      })),
    };
  }
}
