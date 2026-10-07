import { ApiProperty } from '@nestjs/swagger';
import {
  SlaClockState,
  TicketAssignmentType,
  TicketAttachmentKind,
  TicketConfirmationStatus,
  TicketFeedbackKind,
  TicketHoldReason,
  TicketPriority,
  TicketStatus,
  type Ticket,
  type TicketAssignment,
  type TicketStatusHistory,
} from '@prisma/client';
import {
  accountRef,
  AccountRefView,
  erased,
  firstNameOf,
  firstNameRef,
  FirstNameRefView,
  isErased,
} from '../../../core/common/http/personal';
import { TicketCategoryRefView } from '../../categories/views/category.views';
import type { SlaSummary } from '../../sla/sla.service';
import { ticketNumber } from '../ticket-rules';
import type {
  HistoryRead,
  Person,
  PhotoRead,
  TicketDetail,
  TicketRead,
} from '../tickets.service';

// ============================================================================
// One view per audience (ADR 0032). Residents and the technician see people
// by their first name only; dispatch sees full names. Nobody sees a phone,
// an email or a document here, except the technician's view of a reporter
// who consented to share their phone (ADR 0036). Photos are presigned URLs, in no-store
// details only.
// ============================================================================

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A ticket's SLA as a resident sees it (ADR 0034). */
export class TicketSlaView {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'While the response clock runs: when it is due.',
  })
  responseDueAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'While the resolution clock runs: when it is due.',
  })
  resolutionDueAt: Date | null;
  @ApiProperty({
    type: Boolean,
    description:
      'A clock is paused: waiting for the resident, for parts, or for a confirmation.',
  })
  paused: boolean;

  static from(s: SlaSummary | null): TicketSlaView | null {
    return s
      ? {
          responseDueAt: s.responseDueAt,
          resolutionDueAt: s.resolutionDueAt,
          paused: s.paused,
        }
      : null;
  }
}

/** Dispatch also sees each clock's state. */
export class DispatchTicketSlaView extends TicketSlaView {
  @ApiProperty({
    enum: SlaClockState,
    enumName: 'SlaClockState',
    nullable: true,
  })
  responseState: SlaClockState | null;
  @ApiProperty({
    enum: SlaClockState,
    enumName: 'SlaClockState',
    nullable: true,
  })
  resolutionState: SlaClockState | null;

  static fromSummary(s: SlaSummary | null): DispatchTicketSlaView | null {
    return s
      ? {
          ...TicketSlaView.from(s)!,
          responseState: s.responseState,
          resolutionState: s.resolutionState,
        }
      : null;
  }
}

function person(r: TicketRead, id: string): Person {
  // A ticket's people always exist: accounts are never deleted (ADR 0023).
  return r.people.get(id) ?? { id, fullName: null, status: 'erased' };
}

const first = (r: TicketRead, id: string) => firstNameRef(person(r, id));
const full = (r: TicketRead, id: string) => accountRef(person(r, id));

export class TicketCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MT-000123' })
  number: string;
  @ApiProperty({ enum: TicketStatus, enumName: 'TicketStatus' })
  status: TicketStatus;
  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' })
  priority: TicketPriority;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /** No description: the stored replay of a create holds no free text. */
  static from(t: Ticket): TicketCreatedView {
    return {
      id: t.id,
      number: ticketNumber(t.number),
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt,
    };
  }
}

export class PhotoView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: TicketAttachmentKind, enumName: 'TicketAttachmentKind' })
  kind: TicketAttachmentKind;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned GET, valid until `expiresAt`.',
  })
  url: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;

  static from(p: PhotoRead): PhotoView {
    return {
      id: p.id,
      kind: p.kind,
      cycle: p.cycle,
      url: p.read?.url ?? null,
      expiresAt: p.read?.expiresAt ?? null,
    };
  }
}

export class PhotoAddedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: TicketAttachmentKind, enumName: 'TicketAttachmentKind' })
  kind: TicketAttachmentKind;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(a: {
    id: string;
    kind: TicketAttachmentKind;
    cycle: number;
    createdAt: Date;
  }): PhotoAddedView {
    return { id: a.id, kind: a.kind, cycle: a.cycle, createdAt: a.createdAt };
  }
}

// --- residents ---------------------------------------------------------------

export class ResidentTicketView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MT-000123' })
  number: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  commonArea: string | null;
  @ApiProperty({ type: TicketCategoryRefView })
  category: TicketCategoryRefView;
  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' })
  priority: TicketPriority;
  @ApiProperty({ enum: TicketStatus, enumName: 'TicketStatus' })
  status: TicketStatus;
  @ApiProperty({
    enum: TicketHoldReason,
    enumName: 'TicketHoldReason',
    nullable: true,
  })
  holdReason: TicketHoldReason | null;
  @ApiProperty({
    enum: TicketConfirmationStatus,
    enumName: 'TicketConfirmationStatus',
    nullable: true,
  })
  confirmationStatus: TicketConfirmationStatus | null;
  @ApiProperty({ type: Boolean })
  reportedByMe: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(r: TicketRead, me: string): ResidentTicketView {
    const t = r.ticket;
    return {
      id: t.id,
      number: ticketNumber(t.number),
      unitId: t.unitId,
      unitCode: r.unitCode,
      commonArea: t.commonArea,
      category: TicketCategoryRefView.from(r.category),
      priority: t.priority,
      status: t.status,
      holdReason: t.holdReason,
      confirmationStatus: t.confirmationStatus,
      reportedByMe: t.reporterId === me,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}

export class ResidentTicketDetailView extends ResidentTicketView {
  @ApiProperty({ type: String })
  description: string;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ type: FirstNameRefView })
  reporter: FirstNameRefView;
  @ApiProperty({
    type: Boolean,
    description: 'Opened by management for the reporter; never who.',
  })
  onBehalf: boolean;
  @ApiProperty({ type: FirstNameRefView, nullable: true })
  technician: FirstNameRefView | null;
  @ApiProperty({ type: [PhotoView] })
  photos: PhotoView[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'While completed: when it closes by itself if nobody confirms or rejects.',
  })
  autoCloseAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'While closed: until when it may be reopened.',
  })
  reopenUntil: Date | null;
  @ApiProperty({
    type: TicketSlaView,
    nullable: true,
    description: 'Null while the compound does not measure an SLA.',
  })
  sla: TicketSlaView | null;

  static fromDetail(d: TicketDetail, me: string): ResidentTicketDetailView {
    const t = d.ticket;
    return {
      ...ResidentTicketView.from(d, me),
      description: t.description,
      cycle: t.cycle,
      reporter: first(d, t.reporterId),
      onBehalf: t.createdById !== t.reporterId,
      technician: t.technicianId ? first(d, t.technicianId) : null,
      photos: d.photos.map((p) => PhotoView.from(p)),
      completedAt: t.completedAt,
      closedAt: t.closedAt,
      autoCloseAt:
        t.status === 'completed' && t.completedAt
          ? new Date(t.completedAt.getTime() + d.settings.autoCloseHours * HOUR)
          : null,
      reopenUntil:
        t.status === 'closed' && t.closedAt
          ? new Date(t.closedAt.getTime() + d.settings.reopenDays * DAY)
          : null,
      sla: TicketSlaView.from(d.sla),
    };
  }
}

// --- the technician ------------------------------------------------------------

export class TechnicianTicketView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MT-000123' })
  number: string;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  commonArea: string | null;
  @ApiProperty({ type: TicketCategoryRefView })
  category: TicketCategoryRefView;
  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' })
  priority: TicketPriority;
  @ApiProperty({ enum: TicketStatus, enumName: 'TicketStatus' })
  status: TicketStatus;
  @ApiProperty({
    enum: TicketHoldReason,
    enumName: 'TicketHoldReason',
    nullable: true,
  })
  holdReason: TicketHoldReason | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  assignedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: TicketRead): TechnicianTicketView {
    const t = r.ticket;
    return {
      id: t.id,
      number: ticketNumber(t.number),
      unitCode: r.unitCode,
      commonArea: t.commonArea,
      category: TicketCategoryRefView.from(r.category),
      priority: t.priority,
      status: t.status,
      holdReason: t.holdReason,
      assignedAt: t.assignedAt,
      createdAt: t.createdAt,
    };
  }
}

export class TechnicianTicketDetailView extends TechnicianTicketView {
  @ApiProperty({ type: String })
  description: string;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({
    type: Number,
    description: 'Rejections and reopens so far.',
  })
  rejectionCount: number;
  @ApiProperty({
    enum: TicketConfirmationStatus,
    enumName: 'TicketConfirmationStatus',
    nullable: true,
  })
  confirmationStatus: TicketConfirmationStatus | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The reporter's first name, and nothing else about them: coordination goes through messages.",
  })
  reporterFirstName: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The reporter's phone, only while the reporter allows it (consent `ticket_phone_share`), still has the ticket's unit, and the work is open (ADR 0036). Otherwise null.",
  })
  reporterPhone: string | null;
  @ApiProperty({ type: [PhotoView] })
  photos: PhotoView[];

  static fromDetail(d: TicketDetail): TechnicianTicketDetailView {
    const t = d.ticket;
    const reporter = person(d, t.reporterId);
    return {
      ...TechnicianTicketView.from(d),
      description: t.description,
      cycle: t.cycle,
      rejectionCount: t.rejectionCount,
      confirmationStatus: t.confirmationStatus,
      reporterFirstName: isErased(reporter)
        ? null
        : firstNameOf(reporter.fullName),
      reporterPhone: d.reporterPhone,
      photos: d.photos.map((p) => PhotoView.from(p)),
    };
  }
}

// --- dispatch ----------------------------------------------------------------

export class TicketUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
}

export class DispatchTicketView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MT-000123' })
  number: string;
  @ApiProperty({ type: TicketUnitView, nullable: true })
  unit: TicketUnitView | null;
  @ApiProperty({ type: String, nullable: true })
  commonArea: string | null;
  @ApiProperty({ type: TicketCategoryRefView })
  category: TicketCategoryRefView;
  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' })
  priority: TicketPriority;
  @ApiProperty({ enum: TicketStatus, enumName: 'TicketStatus' })
  status: TicketStatus;
  @ApiProperty({
    enum: TicketHoldReason,
    enumName: 'TicketHoldReason',
    nullable: true,
  })
  holdReason: TicketHoldReason | null;
  @ApiProperty({
    enum: TicketConfirmationStatus,
    enumName: 'TicketConfirmationStatus',
    nullable: true,
  })
  confirmationStatus: TicketConfirmationStatus | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  technician: AccountRefView | null;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ type: Number })
  rejectionCount: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static from(r: TicketRead): DispatchTicketView {
    const t = r.ticket;
    return {
      id: t.id,
      number: ticketNumber(t.number),
      unit: t.unitId ? { id: t.unitId, code: r.unitCode ?? '' } : null,
      commonArea: t.commonArea,
      category: TicketCategoryRefView.from(r.category),
      priority: t.priority,
      status: t.status,
      holdReason: t.holdReason,
      confirmationStatus: t.confirmationStatus,
      technician: t.technicianId ? full(r, t.technicianId) : null,
      cycle: t.cycle,
      rejectionCount: t.rejectionCount,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}

export class FeedbackView {
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ enum: TicketFeedbackKind, enumName: 'TicketFeedbackKind' })
  kind: TicketFeedbackKind;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '1–5, confirmed only.',
  })
  rating: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '1–5, the technician who did the work (ADR 0038); optional.',
  })
  technicianRating: number | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Who `technicianRating` rates.',
  })
  ratedTechnician: AccountRefView | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The confirmation's comment; null once its author is erased.",
  })
  comment: string | null;
  @ApiProperty({ type: AccountRefView })
  author: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class DispatchTicketDetailView extends DispatchTicketView {
  @ApiProperty({ type: String })
  description: string;
  @ApiProperty({ type: AccountRefView })
  reporter: AccountRefView;
  @ApiProperty({ type: AccountRefView })
  createdBy: AccountRefView;
  @ApiProperty({ type: [PhotoView] })
  photos: PhotoView[];
  @ApiProperty({ type: [FeedbackView] })
  feedback: FeedbackView[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    type: DispatchTicketSlaView,
    nullable: true,
    description: 'Null while the compound does not measure an SLA.',
  })
  sla: DispatchTicketSlaView | null;

  static fromDetail(d: TicketDetail): DispatchTicketDetailView {
    const t = d.ticket;
    return {
      ...DispatchTicketView.from(d),
      description: t.description,
      reporter: full(d, t.reporterId),
      createdBy: full(d, t.createdById),
      photos: d.photos.map((p) => PhotoView.from(p)),
      feedback: d.feedback.map((f) => ({
        cycle: f.cycle,
        kind: f.kind,
        rating: f.rating,
        technicianRating: f.technicianRating,
        ratedTechnician: f.ratedTechnicianId
          ? full(d, f.ratedTechnicianId)
          : null,
        reasonCode: f.reasonCode,
        comment: f.comment,
        author: full(d, f.authorId),
        createdAt: f.createdAt,
      })),
      completedAt: t.completedAt,
      closedAt: t.closedAt,
      cancelledAt: t.cancelledAt,
      sla: DispatchTicketSlaView.fromSummary(d.sla),
    };
  }
}

function ref(people: Map<string, Person>, id: string | null) {
  if (!id) return null;
  const p = people.get(id);
  return p ? accountRef(p) : erased(id);
}

export class StatusHistoryView {
  @ApiProperty({ enum: TicketStatus, enumName: 'TicketStatus', nullable: true })
  fromStatus: TicketStatus | null;
  @ApiProperty({ enum: TicketStatus, enumName: 'TicketStatus' })
  toStatus: TicketStatus;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null for the system.',
  })
  actor: AccountRefView | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static list(h: HistoryRead<TicketStatusHistory>): StatusHistoryView[] {
    return h.rows.map((r) => ({
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      actor: ref(h.people, r.actorId),
      reasonCode: r.reasonCode,
      cycle: r.cycle,
      at: r.createdAt,
    }));
  }
}

export class AssignmentView {
  @ApiProperty({
    enum: TicketAssignmentType,
    enumName: 'TicketAssignmentType',
  })
  type: TicketAssignmentType;
  @ApiProperty({ type: AccountRefView, nullable: true })
  from: AccountRefView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  to: AccountRefView | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Who acted; null for the system.',
  })
  by: AccountRefView | null;
  @ApiProperty({ type: String, nullable: true })
  reasonCode: string | null;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static list(h: HistoryRead<TicketAssignment>): AssignmentView[] {
    return h.rows.map((r) => ({
      type: r.assignmentType,
      from: ref(h.people, r.fromId),
      to: ref(h.people, r.toId),
      by: ref(h.people, r.assignedById),
      reasonCode: r.reasonCode,
      cycle: r.cycle,
      at: r.createdAt,
    }));
  }
}
