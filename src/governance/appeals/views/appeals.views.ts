import { ApiProperty } from '@nestjs/swagger';
import {
  APPEAL_EFFECTS,
  APPEAL_STATUSES,
  BOARD_APPEAL_KINDS,
  appealReference,
  type AppealEffect,
  type AppealStatus,
  type BoardAppealKind,
} from '../appeal-rules';
import type { AppealRecord, BoardAppealRecord } from '../appeals.service';
import { BoardMotionView } from '../../motions/views/motions.views';

export class BoardAppealDecisionView {
  @ApiProperty({
    enum: ['upheld', 'overturned'],
    enumName: 'BoardAppealOutcome',
  })
  outcome: 'upheld' | 'overturned';
  @ApiProperty({ type: String, format: 'date-time' })
  decidedAt: Date;
  @ApiProperty({ type: String, description: 'The board’s reasons.' })
  rationale: string;
}

export class BoardAppealAttachmentView {
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
class AppealBase {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'BA-0001' })
  reference: string;
  @ApiProperty({ enum: BOARD_APPEAL_KINDS, enumName: 'BoardAppealKind' })
  kind: BoardAppealKind;
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The decision appealed: a fine, a violation, a suspension or a dispute.',
  })
  subjectId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: APPEAL_STATUSES, enumName: 'BoardAppealStatus' })
  status: AppealStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  lodgedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  deadlineAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt: Date | null;
  @ApiProperty({ type: BoardAppealDecisionView, nullable: true })
  decision: BoardAppealDecisionView | null;

  static base(r: AppealRecord): AppealBase {
    const a = r.appeal;
    return {
      id: a.id,
      reference: appealReference(a.number),
      kind: a.kind as BoardAppealKind,
      subjectId: a.subjectId,
      unitCode: r.unitCode,
      status: a.status as AppealStatus,
      lodgedAt: a.lodgedAt,
      deadlineAt: a.deadlineAt,
      withdrawnAt: a.withdrawnAt,
      decision:
        a.decidedAt && r.decision
          ? {
              outcome: a.status as 'upheld' | 'overturned',
              decidedAt: a.decidedAt,
              rationale: r.decision.rationale,
            }
          : null,
    };
  }
}

/**
 * An appeal to the board (ADR 0055) as an owner of its unit, or its
 * primary, reads it: the grounds and attachments to the appellant only.
 */
export class BoardAppealView extends AppealBase {
  @ApiProperty({ type: Boolean, description: 'The caller appealed.' })
  mine: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The appellant’s words, to the appellant only; null once cleared.',
  })
  grounds: string | null;
  @ApiProperty({ type: [BoardAppealAttachmentView] })
  attachments: BoardAppealAttachmentView[];
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'The decision appealed, as its domain describes it: codes, amounts, dates.',
  })
  subject: unknown;

  static from(r: AppealRecord): BoardAppealView {
    return {
      ...AppealBase.base(r),
      mine: r.mine,
      grounds: r.mine ? r.appeal.grounds : null,
      attachments: r.mine ? r.attachments : [],
      subject: r.subject,
    };
  }
}

/**
 * An appeal as the management reads it (a party: it decided): where it
 * stands, the board's decision and reasons, the follow-up. Never the
 * grounds, a motion, a vote or a count.
 */
export class StaffBoardAppealView extends AppealBase {
  @ApiProperty({ type: Boolean, description: 'Pending past its deadline.' })
  overdue: boolean;
  @ApiProperty({
    enum: APPEAL_EFFECTS,
    enumName: 'BoardAppealEffect',
    nullable: true,
    description:
      'What the decision did: applied by its domain (a fine or violation cancelled, a suspension lifted), left to the management to follow up, or nothing.',
  })
  effect: AppealEffect | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  followedUpAt: Date | null;

  static from(r: AppealRecord): StaffBoardAppealView {
    const a = r.appeal;
    return {
      ...AppealBase.base(r),
      overdue: a.status === 'pending' && a.deadlineAt <= r.now,
      effect: a.effect as AppealEffect | null,
      followedUpAt: a.followedUpAt,
    };
  }
}

/** An appeal as the board reads it: the grounds, the subject, its motions. */
export class BoardAppealBoardView extends StaffBoardAppealView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The appellant’s words; null once cleared by their erasure.',
  })
  grounds: string | null;
  @ApiProperty({ type: [BoardAppealAttachmentView] })
  attachments: BoardAppealAttachmentView[];
  @ApiProperty({ type: Object, nullable: true })
  subject: unknown;
  @ApiProperty({ type: [BoardMotionView] })
  motions: BoardMotionView[];

  static fromBoard(r: BoardAppealRecord): BoardAppealBoardView {
    return {
      ...StaffBoardAppealView.from(r),
      grounds: r.appeal.grounds,
      attachments: r.attachments,
      subject: r.subject,
      motions: r.motions.map((m) => BoardMotionView.from(m)),
    };
  }
}
