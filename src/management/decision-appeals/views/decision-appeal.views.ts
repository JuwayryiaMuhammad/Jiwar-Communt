import { ApiProperty } from '@nestjs/swagger';
import {
  DECISION_APPEAL_EFFECT_REASONS,
  DECISION_APPEAL_EFFECTS,
  DECISION_APPEAL_KINDS,
  DECISION_APPEAL_STATUSES,
  decisionAppealReference,
  type DecisionAppealEffectCode,
  type DecisionAppealEffectReason,
  type DecisionAppealKind,
  type DecisionAppealStatus,
} from '../appeal-rules';
import type { DecisionAppealRecord } from '../decision-appeals.service';

export class DecisionAppealDeciderView {
  @ApiProperty({
    type: String,
    description:
      'The deciding manager’s role key as it was then (never a person).',
  })
  roleKey: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The role’s name in the compound then; null when unnamed.',
  })
  roleName: string | null;
}

export class DecisionAppealDecisionView {
  @ApiProperty({
    enum: ['upheld', 'overturned'],
    enumName: 'DecisionAppealOutcome',
  })
  outcome: 'upheld' | 'overturned';
  @ApiProperty({ type: String, format: 'date-time' })
  decidedAt: Date;
  @ApiProperty({
    type: String,
    description: 'The manager’s reasons, as the appellant reads them.',
  })
  rationale: string;
  @ApiProperty({ type: DecisionAppealDeciderView })
  decidedBy: DecisionAppealDeciderView;
  @ApiProperty({
    enum: DECISION_APPEAL_EFFECTS,
    enumName: 'DecisionAppealEffect',
    description:
      'What the decision did: applied by its domain (a permit approved, a vehicle activated, a notice withdrawn), left to the management to follow up, or nothing.',
  })
  effect: DecisionAppealEffectCode;
  @ApiProperty({
    enum: DECISION_APPEAL_EFFECT_REASONS,
    enumName: 'DecisionAppealEffectReason',
    nullable: true,
    description:
      'Why an overturn was left to the management, or did nothing: the check that refused it.',
  })
  effectReason: DecisionAppealEffectReason | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  followedUpAt: Date | null;
}

export class DecisionAppealAttachmentView {
  @ApiProperty({ type: String, format: 'uuid' })
  fileId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A short-lived read URL; null once the file is gone.',
  })
  url: string | null;
}

/** What every view of an appeal says. */
class DecisionAppealBase {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'AP-000001' })
  reference: string;
  @ApiProperty({ enum: DECISION_APPEAL_KINDS, enumName: 'DecisionAppealKind' })
  kind: DecisionAppealKind;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The decision appealed: a permit, a vehicle, a worker’s engagement, a neighbour notice.',
  })
  subjectId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({
    enum: DECISION_APPEAL_STATUSES,
    enumName: 'DecisionAppealStatus',
  })
  status: DecisionAppealStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  decisionAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  lodgedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Upheld and taken on to the board (a board appeal of kind `management_appeal`).',
  })
  takenToBoardAt: Date | null;
  @ApiProperty({ type: DecisionAppealDecisionView, nullable: true })
  decision: DecisionAppealDecisionView | null;
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'The decision appealed, as its domain describes it: codes and dates.',
  })
  subject: unknown;

  static base(r: DecisionAppealRecord): DecisionAppealBase {
    const a = r.appeal;
    return {
      id: a.id,
      reference: decisionAppealReference(a.number),
      kind: a.kind as DecisionAppealKind,
      subjectId: a.subjectId,
      unitCode: r.unitCode,
      status: a.status as DecisionAppealStatus,
      decisionAt: a.decisionAt,
      lodgedAt: a.lodgedAt,
      withdrawnAt: a.withdrawnAt,
      takenToBoardAt: a.boardAppealAt,
      decision:
        a.decidedAt && a.rationale && a.deciderRoleKey
          ? {
              outcome: a.status as 'upheld' | 'overturned',
              decidedAt: a.decidedAt,
              rationale: a.rationale,
              decidedBy: {
                roleKey: a.deciderRoleKey,
                roleName: a.deciderRoleName,
              },
              effect: a.effect as DecisionAppealEffectCode,
              effectReason: a.effectReason as DecisionAppealEffectReason | null,
              followedUpAt: a.followedUpAt,
            }
          : null,
      subject: r.subject,
    };
  }
}

/**
 * A decision appeal (ADR 0059) as a resident reads it: the appellant with
 * their grounds and attachments, the unit's primary without them.
 */
export class DecisionAppealView extends DecisionAppealBase {
  @ApiProperty({ type: Boolean, description: 'The caller appealed.' })
  mine: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The appellant’s words, to the appellant only; null once cleared.',
  })
  grounds: string | null;
  @ApiProperty({ type: [DecisionAppealAttachmentView] })
  attachments: DecisionAppealAttachmentView[];

  static from(r: DecisionAppealRecord): DecisionAppealView {
    return {
      ...DecisionAppealBase.base(r),
      mine: r.mine,
      grounds: r.mine ? r.appeal.grounds : null,
      attachments: r.mine ? r.attachments : [],
    };
  }
}

/**
 * A decision appeal as the deciders read it: the grounds and attachments
 * (absent from the list), and whether the caller took the decision (and so
 * may not decide it).
 */
export class StaffDecisionAppealView extends DecisionAppealBase {
  @ApiProperty({
    type: Boolean,
    description:
      'The caller took the decision appealed: another manager decides it.',
  })
  ownDecision: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The appellant’s words; null once cleared by their erasure.',
  })
  grounds: string | null;
  @ApiProperty({ type: [DecisionAppealAttachmentView] })
  attachments: DecisionAppealAttachmentView[];

  static from(r: DecisionAppealRecord, me: string): StaffDecisionAppealView {
    return {
      ...DecisionAppealBase.base(r),
      ownDecision: r.appeal.decisionById === me,
      grounds: r.appeal.grounds,
      attachments: r.attachments,
    };
  }
}
