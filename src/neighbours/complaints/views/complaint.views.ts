import { ApiProperty } from '@nestjs/swagger';
import {
  NeighbourComplaintStatus,
  NeighbourRecipientKind,
  NeighbourSide,
  type NeighbourComplaint,
  type NeighbourComplaintStatusChange,
} from '@prisma/client';
import type { NeighbourUnit } from '../../../community';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { ComplaintCategoryOptionView } from '../../categories/views/category.views';
import { complaintNumber, isOpen } from '../complaint-rules';
import type {
  AuthorPattern,
  ComplaintDetail,
  ComplaintRead,
  HistoryRead,
  NoticeFacts,
  StaffComplaintDetail,
  StaffComplaintRead,
  UnitHistory,
  UnitTally,
} from '../complaints.service';

// ============================================================================
// One view per side (ADR 0042). The author sees their own complaint, the
// unit by the code they typed, and no staff name beyond the conversation.
// Staff see the author by full name, the unit, the notice and who it went
// to, the unit's past and the author's habits. The unit complained about
// has no view of the complaint at all: see notice.views.ts.
// ============================================================================

/** The answer to filing a complaint: enough to show and to fetch it. */
export class ComplaintCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'NC-000123' })
  number: string;
  @ApiProperty({
    enum: NeighbourComplaintStatus,
    enumName: 'NeighbourComplaintStatus',
  })
  status: NeighbourComplaintStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(c: NeighbourComplaint): ComplaintCreatedView {
    return {
      id: c.id,
      number: complaintNumber(c.number),
      status: c.status,
      createdAt: c.createdAt,
    };
  }
}

/** What both the author and the staff see of a complaint. */
class ComplaintBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'NC-000123' })
  number: string;
  @ApiProperty({ type: ComplaintCategoryOptionView })
  category: ComplaintCategoryOptionView;
  @ApiProperty({
    enum: NeighbourComplaintStatus,
    enumName: 'NeighbourComplaintStatus',
  })
  status: NeighbourComplaintStatus;
  @ApiProperty({
    type: Boolean,
    description: 'Neither resolved nor dismissed.',
  })
  open: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why it ended: a code of `neighbourComplaintResolve` or `neighbourComplaintDismiss`, or `withdrawn`.',
  })
  closeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  lastActivityAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  protected static base(r: ComplaintRead): ComplaintBaseView {
    const c = r.complaint;
    return {
      id: c.id,
      number: complaintNumber(c.number),
      category: ComplaintCategoryOptionView.from(r.category),
      status: c.status,
      open: isOpen(c.status),
      closeReason: c.closeReason,
      closedAt: c.closedAt,
      lastActivityAt: c.lastActivityAt,
      createdAt: c.createdAt,
    };
  }
}

/**
 * A complaint as its author sees it. The unit complained about is its
 * code, the one the author typed: nothing about who lives there.
 */
export class ResidentComplaintView extends ComplaintBaseView {
  @ApiProperty({ type: String, description: 'The unit complained about.' })
  targetUnitCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The author’s own unit, when the complaint names one.',
  })
  unitCode: string | null;

  static from(r: ComplaintRead): ResidentComplaintView {
    return {
      ...ComplaintBaseView.base(r),
      targetUnitCode: r.targetUnit.code,
      unitCode: r.authorUnit?.code ?? null,
    };
  }
}

/** One status the complaint has had, as its author sees it: no staff name. */
export class ComplaintStatusStepView {
  @ApiProperty({
    enum: NeighbourComplaintStatus,
    enumName: 'NeighbourComplaintStatus',
  })
  status: NeighbourComplaintStatus;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static from(h: NeighbourComplaintStatusChange): ComplaintStatusStepView {
    return { status: h.toStatus, reasonCode: h.reasonCode, at: h.createdAt };
  }
}

export class ResidentComplaintDetailView extends ResidentComplaintView {
  @ApiProperty({ type: [ComplaintStatusStepView] })
  history: ComplaintStatusStepView[];

  static fromDetail(r: ComplaintDetail): ResidentComplaintDetailView {
    return {
      ...ResidentComplaintView.from(r),
      history: r.history.map((h) => ComplaintStatusStepView.from(h)),
    };
  }
}

export class ComplaintUnitRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;

  static from(u: NeighbourUnit): ComplaintUnitRefView {
    return { id: u.id, code: u.code, building: u.building };
  }
}

/** How many complaints there are against a unit. Staff only. */
export class ComplaintUnitTallyView {
  @ApiProperty({ type: Number })
  total: number;
  @ApiProperty({ type: Number })
  open: number;

  static from(t: UnitTally): ComplaintUnitTallyView {
    return { total: t.total, open: t.open };
  }
}

/** A complaint in the staff inbox. */
export class StaffComplaintView extends ComplaintBaseView {
  @ApiProperty({ type: AccountRefView, description: 'Who complained.' })
  author: AccountRefView;
  @ApiProperty({ type: ComplaintUnitRefView, nullable: true })
  authorUnit: ComplaintUnitRefView | null;
  @ApiProperty({ type: ComplaintUnitRefView })
  targetUnit: ComplaintUnitRefView;
  @ApiProperty({
    type: ComplaintUnitTallyView,
    description: 'Complaints against the same unit, this one included.',
  })
  againstUnit: ComplaintUnitTallyView;

  static from(r: StaffComplaintRead): StaffComplaintView {
    return {
      ...ComplaintBaseView.base(r),
      author: accountRef(r.author),
      authorUnit: r.authorUnit && ComplaintUnitRefView.from(r.authorUnit),
      targetUnit: ComplaintUnitRefView.from(r.targetUnit),
      againstUnit: ComplaintUnitTallyView.from(r.againstUnit),
    };
  }
}

export class ComplaintHistoryView {
  @ApiProperty({
    enum: NeighbourComplaintStatus,
    enumName: 'NeighbourComplaintStatus',
    nullable: true,
    description: 'Null on the first row: the filing.',
  })
  from: NeighbourComplaintStatus | null;
  @ApiProperty({
    enum: NeighbourComplaintStatus,
    enumName: 'NeighbourComplaintStatus',
  })
  to: NeighbourComplaintStatus;
  @ApiProperty({ type: AccountRefView })
  actor: AccountRefView;
  @ApiProperty({ enum: NeighbourSide, enumName: 'NeighbourSide' })
  actorSide: NeighbourSide;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static from(h: HistoryRead): ComplaintHistoryView {
    return {
      from: h.change.fromStatus,
      to: h.change.toStatus,
      actor: accountRef(h.actor),
      actorSide: h.change.actorSide,
      reasonCode: h.change.reasonCode,
      at: h.change.createdAt,
    };
  }
}

/** The notice as the staff who sent it see it. */
export class StaffNoticeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'The management’s own words.' })
  body: string;
  @ApiProperty({
    enum: NeighbourRecipientKind,
    enumName: 'NeighbourRecipientKind',
    description:
      '`household`: the people answering for the household living there. `owners`: nobody lived there.',
  })
  recipientKind: NeighbourRecipientKind;
  @ApiProperty({ type: AccountRefView })
  sentBy: AccountRefView;
  @ApiProperty({ type: [AccountRefView] })
  recipients: AccountRefView[];
  @ApiProperty({ type: String, format: 'date-time' })
  sentAt: Date;

  static from(n: NoticeFacts): StaffNoticeView {
    return {
      id: n.id,
      body: n.body,
      recipientKind: n.recipientKind,
      sentBy: accountRef(n.sentBy),
      recipients: n.recipients.map((r) => accountRef(r)),
      sentAt: n.createdAt,
    };
  }
}

/** What there has been against a unit. Staff only, never a resident. */
export class ComplaintUnitHistoryView extends ComplaintUnitTallyView {
  @ApiProperty({ type: Number })
  resolved: number;
  @ApiProperty({ type: Number })
  dismissed: number;
  @ApiProperty({ type: Number, description: 'Dismissed as unfounded.' })
  unfounded: number;

  static fromHistory(h: UnitHistory): ComplaintUnitHistoryView {
    return {
      total: h.total,
      open: h.open,
      resolved: h.resolved,
      dismissed: h.dismissed,
      unfounded: h.unfounded,
    };
  }
}

/** A unit and what there has been against it. Staff only. */
export class UnitComplaintHistoryView {
  @ApiProperty({ type: ComplaintUnitRefView })
  unit: ComplaintUnitRefView;
  @ApiProperty({ type: ComplaintUnitHistoryView })
  history: ComplaintUnitHistoryView;

  static from(r: {
    unit: NeighbourUnit;
    history: UnitHistory;
  }): UnitComplaintHistoryView {
    return {
      unit: ComplaintUnitRefView.from(r.unit),
      history: ComplaintUnitHistoryView.fromHistory(r.history),
    };
  }
}

/** How the author files. Staff only, never a resident. */
export class ComplaintAuthorPatternView {
  @ApiProperty({ type: Number, description: 'Every complaint they filed.' })
  total: number;
  @ApiProperty({ type: Number })
  open: number;
  @ApiProperty({ type: Number })
  dismissedUnfounded: number;
  @ApiProperty({
    type: Number,
    description: 'Against this same unit, this one included.',
  })
  againstSameUnit: number;

  static from(p: AuthorPattern): ComplaintAuthorPatternView {
    return {
      total: p.total,
      open: p.open,
      dismissedUnfounded: p.dismissedUnfounded,
      againstSameUnit: p.againstSameUnit,
    };
  }
}

export class StaffComplaintDetailView extends StaffComplaintView {
  @ApiProperty({ type: [ComplaintHistoryView] })
  history: ComplaintHistoryView[];
  @ApiProperty({
    type: StaffNoticeView,
    nullable: true,
    description: 'Null until the unit is sent its notice.',
  })
  notice: StaffNoticeView | null;
  @ApiProperty({ type: ComplaintUnitHistoryView })
  unitHistory: ComplaintUnitHistoryView;
  @ApiProperty({ type: ComplaintAuthorPatternView })
  authorPattern: ComplaintAuthorPatternView;

  static fromDetail(r: StaffComplaintDetail): StaffComplaintDetailView {
    return {
      ...StaffComplaintView.from(r),
      history: r.history.map((h) => ComplaintHistoryView.from(h)),
      notice: r.notice && StaffNoticeView.from(r.notice),
      unitHistory: ComplaintUnitHistoryView.fromHistory(r.unitHistory),
      authorPattern: ComplaintAuthorPatternView.from(r.authorPattern),
    };
  }
}
