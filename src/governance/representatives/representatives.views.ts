import { ApiProperty } from '@nestjs/swagger';
import type { RepresentativeMessage } from '@prisma/client';
import { BoardMotionView } from '../motions/views/motions.views';
import {
  REPRESENTATIVE_END_REASONS,
  REPRESENTATIVE_MATTER_ACTIONS,
  REPRESENTATIVE_MATTER_EFFECT_REASONS,
  REPRESENTATIVE_MATTER_STATUSES,
  type RepresentativeEndReason,
  type RepresentativeMatterAction,
  type RepresentativeMatterEffectReason,
  type RepresentativeMatterStatus,
} from './representative-rules';
import type {
  BoardRepresentativeMatterRecord,
  BuildingRepresentative,
  RepresentativeMatterRecord,
  RepresentativeRecord,
  ThreadRecord,
} from './representatives.service';

/** A building's representative as its residents see them (ADR 0059). */
export class BuildingRepresentativeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  building: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Their first name only.',
  })
  firstName: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  since: Date;

  static from(r: BuildingRepresentative): BuildingRepresentativeView {
    return {
      id: r.representative.id,
      building: r.representative.building,
      firstName: r.firstName,
      since: r.representative.appointedAt,
    };
  }
}

/** A representative as the board and the management see them. */
export class RepresentativeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  building: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({
    type: String,
    description: 'The unit they own in the building, when named.',
  })
  unitCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  appointedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    enum: REPRESENTATIVE_END_REASONS,
    enumName: 'RepresentativeEndReason',
    nullable: true,
  })
  endReason: RepresentativeEndReason | null;

  static from(r: RepresentativeRecord): RepresentativeView {
    const x = r.representative;
    return {
      id: x.id,
      building: x.building,
      accountId: x.accountId,
      fullName: r.fullName,
      unitCode: r.unitCode,
      appointedAt: x.appointedAt,
      endedAt: x.endedAt,
      endReason: x.endReason as RepresentativeEndReason | null,
    };
  }
}

/** How the board decided a representative matter (ADR 0059). */
export class RepresentativeMatterDecisionView {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  decision: 'approved' | 'rejected';
  @ApiProperty({ type: String, format: 'date-time' })
  decidedAt: Date;
  @ApiProperty({ type: String, description: 'The carried motion’s reasons.' })
  rationale: string;
  @ApiProperty({
    enum: ['applied', 'not_applied'],
    nullable: true,
    description:
      'An approval: applied at once, or not (`effectReason`); null when rejected.',
  })
  effect: 'applied' | 'not_applied' | null;
  @ApiProperty({
    enum: REPRESENTATIVE_MATTER_EFFECT_REASONS,
    enumName: 'RepresentativeMatterEffectReason',
    nullable: true,
  })
  effectReason: RepresentativeMatterEffectReason | null;
}

/** A board matter about a building's representative (ADR 0059). */
export class RepresentativeMatterView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: REPRESENTATIVE_MATTER_ACTIONS,
    enumName: 'RepresentativeMatterAction',
  })
  action: RepresentativeMatterAction;
  @ApiProperty({ type: String })
  building: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'Whom it names: the owner to appoint, or the term’s holder.',
  })
  accountId: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The term’s unit (an end), or the unit the owner has in the building now (an appointment; null when none).',
  })
  unitCode: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The term to end.',
  })
  representativeId: string | null;
  @ApiProperty({
    enum: REPRESENTATIVE_MATTER_STATUSES,
    enumName: 'RepresentativeMatterStatus',
  })
  status: RepresentativeMatterStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  raisedAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'The caller raised it: only they withdraw it.',
  })
  raisedByMe: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Past it, a member may close a motion as its votes stand, with a quorum.',
  })
  deadlineAt: Date;
  @ApiProperty({ type: RepresentativeMatterDecisionView, nullable: true })
  decision: RepresentativeMatterDecisionView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt: Date | null;

  static from(r: RepresentativeMatterRecord): RepresentativeMatterView {
    const m = r.matter;
    return {
      id: m.id,
      action: m.action as RepresentativeMatterAction,
      building: m.building,
      accountId: m.accountId,
      fullName: r.fullName,
      unitCode: r.unitCode,
      representativeId: m.representativeId,
      status: m.status as RepresentativeMatterStatus,
      raisedAt: m.raisedAt,
      raisedByMe: r.raisedByMe,
      deadlineAt: m.deadlineAt,
      decision:
        m.decidedAt && r.decision
          ? {
              decision: m.status as 'approved' | 'rejected',
              decidedAt: m.decidedAt,
              rationale: r.decision.rationale,
              effect: m.effect as 'applied' | 'not_applied' | null,
              effectReason:
                m.effectReason as RepresentativeMatterEffectReason | null,
            }
          : null,
      withdrawnAt: m.withdrawnAt,
    };
  }
}

/** A matter with the board's motions on it, newest last. */
export class BoardRepresentativeMatterView extends RepresentativeMatterView {
  @ApiProperty({ type: [BoardMotionView] })
  motions: BoardMotionView[];

  static fromBoard(
    r: BoardRepresentativeMatterRecord,
  ): BoardRepresentativeMatterView {
    return {
      ...RepresentativeMatterView.from(r),
      motions: r.motions.map((m) => BoardMotionView.from(m)),
    };
  }
}

/** A resident's thread as the representative sees it: the unit and a first name. */
export class RepresentativeThreadView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  representativeId: string;
  @ApiProperty({ type: String })
  building: string;
  @ApiProperty({ type: String, description: 'The writer’s unit then.' })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  writerFirstName: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  lastMessageAt: Date;

  static from(r: ThreadRecord): RepresentativeThreadView {
    return {
      id: r.thread.id,
      representativeId: r.thread.representativeId,
      building: r.building,
      unitCode: r.unitCode,
      writerFirstName: r.writerFirstName,
      lastMessageAt: r.thread.lastMessageAt,
    };
  }
}

export class RepresentativeMessageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: ['resident', 'representative'] })
  side: 'resident' | 'representative';
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its author’s erasure cleared it.',
  })
  body: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(m: RepresentativeMessage): RepresentativeMessageView {
    return {
      id: m.id,
      side: m.side as 'resident' | 'representative',
      body: m.body,
      createdAt: m.createdAt,
    };
  }
}
