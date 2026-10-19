import { ApiProperty } from '@nestjs/swagger';
import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  approvalReference,
} from '../approval-rules';
import type { ApprovalRecord, BoardApprovalRecord } from '../approvals.service';
import type { ApprovalType } from '../../../core/board-matters/board-matters';
import { BoardMotionView } from '../../motions/views/motions.views';

export class ApprovalAlternativeView {
  @ApiProperty({ type: Number })
  position: number;
  @ApiProperty({ type: String })
  text: string;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  cost: string | null;
}

export class ApprovalAttachmentView {
  @ApiProperty({ type: String, format: 'uuid' })
  fileId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A short-lived read URL.',
  })
  url: string | null;
}

export class ApprovalDecisionView {
  @ApiProperty({ enum: ['approved', 'rejected'], enumName: 'ApprovalDecision' })
  decision: 'approved' | 'rejected';
  @ApiProperty({ type: String, format: 'date-time' })
  decidedAt: Date;
  @ApiProperty({ type: String, description: 'The board’s reasons.' })
  rationale: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why the alternatives were not taken.',
  })
  alternativesNote: string | null;
}

export class ApprovalWithdrawalView {
  @ApiProperty({ type: String, format: 'date-time' })
  withdrawnAt: Date;
  @ApiProperty({ type: String })
  reasonCode: string;
}

export class ApprovalImplementationView {
  @ApiProperty({ type: String, format: 'date-time' })
  implementedAt: Date;
  @ApiProperty({
    type: Boolean,
    description:
      'Implemented by its decision itself (an annual budget made active, an increase added).',
  })
  byDecision: boolean;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
}

/**
 * An approval request (ADR 0055) as the staff read it: the package, where
 * it stands, and the board's decision with its reasons; never a motion,
 * a vote or a count.
 */
export class ApprovalView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'AR-0001' })
  reference: string;
  @ApiProperty({ enum: APPROVAL_TYPES, enumName: 'ApprovalType' })
  type: ApprovalType;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The budget (annual_budget) or budget line (budget_increase).',
  })
  subjectId: string | null;
  @ApiProperty({ type: String })
  context: string;
  @ApiProperty({ type: String })
  impact: string;
  @ApiProperty({ type: String, nullable: true, description: 'EGP.' })
  cost: string | null;
  @ApiProperty({ type: String, example: 'EGP' })
  currency: string;
  @ApiProperty({ type: [ApprovalAlternativeView] })
  alternatives: ApprovalAlternativeView[];
  @ApiProperty({ type: [ApprovalAttachmentView] })
  attachments: ApprovalAttachmentView[];
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The type’s threshold now (the four thresholded types), EGP; shown, not enforced, but for major_contract’s on expenses.',
  })
  threshold: string | null;
  @ApiProperty({ type: Boolean, description: 'The caller raised it.' })
  raisedByMe: boolean;
  @ApiProperty({ enum: APPROVAL_STATUSES, enumName: 'ApprovalStatus' })
  status: (typeof APPROVAL_STATUSES)[number];
  @ApiProperty({ type: String, format: 'date-time' })
  raisedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  deadlineAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'Pending past its deadline.',
  })
  overdue: boolean;
  @ApiProperty({ type: ApprovalDecisionView, nullable: true })
  decision: ApprovalDecisionView | null;
  @ApiProperty({ type: ApprovalWithdrawalView, nullable: true })
  withdrawal: ApprovalWithdrawalView | null;
  @ApiProperty({ type: ApprovalImplementationView, nullable: true })
  implementation: ApprovalImplementationView | null;

  static from(r: ApprovalRecord): ApprovalView {
    const q = r.request;
    return {
      id: q.id,
      reference: approvalReference(q.number),
      type: q.type as ApprovalType,
      subjectId: q.subjectId,
      context: q.context,
      impact: q.impact,
      cost: q.cost?.toFixed(2) ?? null,
      currency: q.currency,
      alternatives: r.alternatives.map((a) => ({
        position: a.position,
        text: a.text,
        cost: a.cost?.toFixed(2) ?? null,
      })),
      attachments: r.attachments,
      threshold: r.threshold,
      raisedByMe: r.raisedByMe,
      status: q.status as ApprovalView['status'],
      raisedAt: q.createdAt,
      deadlineAt: q.deadlineAt,
      overdue: q.status === 'pending' && q.deadlineAt <= r.now,
      decision:
        q.decidedAt && r.decision
          ? {
              decision: q.status as 'approved' | 'rejected',
              decidedAt: q.decidedAt,
              rationale: r.decision.rationale,
              alternativesNote: r.decision.alternativesNote,
            }
          : null,
      withdrawal:
        q.withdrawnAt && q.withdrawReasonCode
          ? { withdrawnAt: q.withdrawnAt, reasonCode: q.withdrawReasonCode }
          : null,
      implementation: q.implementedAt
        ? {
            implementedAt: q.implementedAt,
            byDecision: q.implementedById === null,
            note: q.implementationNote,
          }
        : null,
    };
  }
}

/** The board's view: the package, its subject as its domain describes it, the motions. */
export class BoardApprovalView extends ApprovalView {
  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'The budget (its lines and total) or the line (its allowance and what is spent), as finance describes it; null for the other types.',
  })
  subject: unknown;
  @ApiProperty({ type: [BoardMotionView] })
  motions: BoardMotionView[];

  static fromBoard(r: BoardApprovalRecord): BoardApprovalView {
    return {
      ...ApprovalView.from(r),
      subject: r.subject,
      motions: r.motions.map((m) => BoardMotionView.from(m)),
    };
  }
}
