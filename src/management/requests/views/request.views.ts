import { HOLD_TYPES } from '../../../core/resident-items/resident-items';
import { ApiProperty } from '@nestjs/swagger';
import {
  ManagementRequestStatus,
  ManagementRequestType,
  type ManagementRequest,
  type ManagementRequestRating,
} from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { isOverdue, reopenUntil, requestNumber } from '../request-rules';
import { AppointmentView } from '../../appointments/views/appointment.views';
import type {
  AppointmentRead,
  RatingRead,
  InboxRead,
  Person,
  RequestRead,
  ResidentDetailRead,
  StaffDetailRead,
  TopicRef,
} from '../requests.service';

// ============================================================================
// One view per side (ADR 0039). The author sees their own request and no
// staff name beyond the conversation; staff see the author by full name,
// who handles it and how the response clock stands. Nobody sees a phone, an
// email or a document here.
// ============================================================================

/** The answer to opening a request: enough to show and to fetch it. */
export class RequestCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MR-000123' })
  number: string;
  @ApiProperty({
    enum: ManagementRequestStatus,
    enumName: 'ManagementRequestStatus',
  })
  status: ManagementRequestStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ManagementRequest): RequestCreatedView {
    return {
      id: r.id,
      number: requestNumber(r.number),
      status: r.status,
      createdAt: r.createdAt,
    };
  }
}

/** A request's topic: the compound's own names. */
export class RequestTopicRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;

  static from(t: TopicRef): RequestTopicRefView {
    return { id: t.id, key: t.key, nameAr: t.nameAr, nameEn: t.nameEn };
  }
}

export class RequestUnitRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  code: string | null;
}

/** What both sides see of a request. */
/** What a request to release a hold is about (ADR 0058). */
export class RequestAboutView {
  @ApiProperty({ enum: HOLD_TYPES, enumName: 'HoldType' })
  type: string;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description:
      'Why it was held when the request was opened: a ticket’s hold reason, a work stop’s reason, or `unit_credit`.',
  })
  reasonCode: string;
}

class RequestBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MR-000123' })
  number: string;
  @ApiProperty({
    enum: ManagementRequestType,
    enumName: 'ManagementRequestType',
  })
  type: ManagementRequestType;
  @ApiProperty({
    enum: ManagementRequestStatus,
    enumName: 'ManagementRequestStatus',
  })
  status: ManagementRequestStatus;
  @ApiProperty({ type: RequestTopicRefView })
  topic: RequestTopicRefView;
  @ApiProperty({
    type: RequestUnitRefView,
    nullable: true,
    description: 'The unit the request is about, when it names one.',
  })
  unit: RequestUnitRefView | null;
  @ApiProperty({
    type: Number,
    description: '1 when opened; one more each time it is reopened.',
  })
  cycle: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why it closed: a staff reason, `auto_closed` or `withdrawn_by_author`.',
  })
  closeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'What the lists are ordered by.',
  })
  lastActivityAt: Date;
  @ApiProperty({
    type: RequestAboutView,
    nullable: true,
    description: 'A request to release a hold: what it is about.',
  })
  about: RequestAboutView | null;

  protected static base(read: RequestRead): RequestBaseView {
    const r = read.request;
    return {
      id: r.id,
      number: requestNumber(r.number),
      type: r.type,
      status: r.status,
      topic: RequestTopicRefView.from(read.topic),
      unit: r.unitId ? { id: r.unitId, code: read.unitCode } : null,
      cycle: r.cycle,
      closeReason: r.closeReason,
      closedAt: r.closedAt,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      about:
        r.aboutType && r.aboutId && r.aboutReason
          ? { type: r.aboutType, id: r.aboutId, reasonCode: r.aboutReason }
          : null,
    };
  }
}

/** A request as its author sees it. */
export class ResidentRequestView extends RequestBaseView {
  @ApiProperty({
    type: Boolean,
    description: 'Opened by the management on the author’s behalf.',
  })
  openedByManagement: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'While the request waits for a first response: when the management means to give it.',
  })
  responseDueAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'On a closed request: until when the author may reopen it.',
  })
  reopenUntil: Date | null;

  static from(read: RequestRead): ResidentRequestView {
    const r = read.request;
    const waiting =
      (r.status === 'open' || r.status === 'in_progress') &&
      r.firstResponseAt === null;
    return {
      ...RequestBaseView.base(read),
      openedByManagement: r.openedById !== null,
      responseDueAt: waiting ? r.responseDueAt : null,
      reopenUntil: r.closedAt ? reopenUntil(r.closedAt) : null,
    };
  }
}

/** A request's rating: by its author, once, never changed. */
export class RequestRatingView {
  @ApiProperty({ type: Number, minimum: 1, maximum: 5 })
  rating: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Optional; null too once its author was erased.',
  })
  comment: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ManagementRequestRating): RequestRatingView {
    return { rating: r.rating, comment: r.comment, createdAt: r.createdAt };
  }
}

/** One of the author's requests, with its appointment. */
export class ResidentRequestDetailView extends ResidentRequestView {
  @ApiProperty({
    type: AppointmentView,
    nullable: true,
    description:
      'On an appointment request: the live appointment, else the last one.',
  })
  appointment: AppointmentView | null;
  @ApiProperty({
    type: RequestRatingView,
    nullable: true,
    description: 'The author’s own rating, once given.',
  })
  rating: RequestRatingView | null;

  static fromDetail(read: ResidentDetailRead): ResidentRequestDetailView {
    return {
      ...ResidentRequestView.from(read),
      rating: read.rating ? RequestRatingView.from(read.rating) : null,
      appointment: read.appointment
        ? AppointmentView.from(read.appointment)
        : null,
    };
  }
}

function person(people: Map<string, Person>, id: string): AccountRefView {
  // A request's people always exist: accounts are never deleted (ADR 0023).
  return accountRef(people.get(id) ?? { id, fullName: null, status: 'erased' });
}

/** A request as the staff see it. */
export class StaffRequestView extends RequestBaseView {
  @ApiProperty({ type: AccountRefView })
  author: AccountRefView;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'The staff member who opened it for the author.',
  })
  openedBy: AccountRefView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it was opened on the author’s behalf (a reason code).',
  })
  onBehalfReason: string | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null: in the unassigned queue.',
  })
  assignee: AccountRefView | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'The cycle’s response time: its start plus the topic’s target.',
  })
  responseDueAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'The cycle’s first staff response.',
  })
  firstResponseAt: Date | null;
  @ApiProperty({
    type: Boolean,
    description:
      'The response time has passed and nobody has responded in this cycle.',
  })
  overdue: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When this cycle was escalated (at most once).',
  })
  escalatedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  answeredAt: Date | null;

  static from(read: RequestRead): StaffRequestView {
    const r = read.request;
    return {
      ...RequestBaseView.base(read),
      author: person(read.people, r.authorId),
      openedBy: r.openedById ? person(read.people, r.openedById) : null,
      onBehalfReason: r.onBehalfReason,
      assignee: r.assigneeId ? person(read.people, r.assigneeId) : null,
      responseDueAt: r.responseDueAt,
      firstResponseAt: r.firstResponseAt,
      overdue: isOverdue(r, read.now),
      escalatedAt: r.escalatedAt,
      answeredAt: r.answeredAt,
    };
  }
}

/** One escalation: the cycle whose response time passed, and when. */
export class RequestEscalationView {
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'The response time that passed.',
  })
  dueAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  escalatedAt: Date;
}

/** One request as staff read it. */
export class StaffRequestDetailView extends StaffRequestView {
  @ApiProperty({
    type: [RequestEscalationView],
    description: 'At most one per cycle, oldest first.',
  })
  escalations: RequestEscalationView[];
  @ApiProperty({
    type: AppointmentView,
    nullable: true,
    description:
      'On an appointment request: the live appointment, else the last one.',
  })
  appointment: AppointmentView | null;

  static fromDetail(read: StaffDetailRead): StaffRequestDetailView {
    return {
      ...StaffRequestView.from(read),
      appointment: read.appointment
        ? AppointmentView.from(read.appointment)
        : null,
      escalations: read.escalations.map((e) => ({
        cycle: e.cycle,
        dueAt: e.dueAt,
        escalatedAt: e.createdAt,
      })),
    };
  }
}

/** A row of the staff inbox. */
export class StaffRequestListItemView extends StaffRequestView {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 120,
    description:
      'The first 120 characters of the request’s first message, as written. Null once that message was erased. Staff inbox only.',
  })
  preview: string | null;

  static fromInbox(read: InboxRead): StaffRequestListItemView {
    return { ...StaffRequestView.from(read), preview: read.preview };
  }
}

/** Someone a request may be opened for, or given to: an id and a name. */
export class RequestPersonView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
}

/** A row of the staff's agenda: an appointment and the request it is on. */
export class StaffAppointmentListItemView extends AppointmentView {
  @ApiProperty({ type: StaffRequestView })
  request: StaffRequestView;

  static fromRead(read: AppointmentRead): StaffAppointmentListItemView {
    return {
      ...AppointmentView.from(read.appointment),
      request: StaffRequestView.from(read.request),
    };
  }
}

/** What `requests.manage` reads of one request's rating: it, or nothing yet. */
export class ManagerRequestRatingView {
  @ApiProperty({
    type: RequestRatingView,
    nullable: true,
    description: 'Null: the author has not rated the request.',
  })
  rating: RequestRatingView | null;
}

/** A row of the manager's ratings: the rating and the request it is of. */
export class RatingListItemView extends RequestRatingView {
  @ApiProperty({ type: StaffRequestView })
  request: StaffRequestView;

  static fromRead(read: RatingRead): RatingListItemView {
    return {
      ...RequestRatingView.from(read.rating),
      request: StaffRequestView.from(read.request),
    };
  }
}
