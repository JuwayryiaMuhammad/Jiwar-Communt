import { ApiProperty } from '@nestjs/swagger';
import type { BoardMeeting } from '@prisma/client';
import { fromDate } from '../db-clock';
import {
  ACTION_STATUSES,
  AGENDA_ITEM_KINDS,
  MEETING_KINDS,
  MEETING_STATUSES,
  type ActionStatus,
  type AgendaItemKind,
  type MeetingKind,
  type MeetingStatus,
} from './meeting-rules';
import type {
  ActionRecord,
  AgendaItemRecord,
  AttendanceRecord,
  MeetingRecord,
} from './meetings.service';

const ref = (n: number) => `BM-${String(n).padStart(4, '0')}`;

export class MeetingAgendaItemView {
  @ApiProperty({ type: Number })
  position: number;
  @ApiProperty({ enum: AGENDA_ITEM_KINDS, enumName: 'BoardMeetingAgendaKind' })
  kind: AgendaItemKind;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  subjectId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'AR-0007',
    description: 'A request’s or an appeal’s reference; null otherwise.',
  })
  reference: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The subject’s status now; null for an item of its own.',
  })
  subjectStatus: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The item’s own words, or the proposal’s title (null once its proposer was erased).',
  })
  title: string | null;

  static from(i: AgendaItemRecord): MeetingAgendaItemView {
    return { ...i };
  }
}

export class MeetingAttendanceView {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ type: String, example: 'chair' })
  role: string;
  @ApiProperty({ type: Boolean })
  present: boolean;

  static from(a: AttendanceRecord): MeetingAttendanceView {
    return { ...a };
  }
}

export class MeetingActionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  meetingId: string;
  @ApiProperty({ type: String, example: 'BM-0003' })
  meetingReference: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ownerAccountId: string;
  @ApiProperty({ type: String, nullable: true })
  ownerName: string | null;
  @ApiProperty({ type: String, format: 'date', example: '2027-03-01' })
  dueOn: string;
  @ApiProperty({ enum: ACTION_STATUSES, enumName: 'BoardMeetingActionStatus' })
  status: ActionStatus;
  @ApiProperty({
    type: Boolean,
    description: 'Open past its due day, by the compound’s day.',
  })
  overdue: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  doneAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  doneNote: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From `boardActionCancel`, once cancelled.',
  })
  cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ActionRecord): MeetingActionView {
    const a = r.action;
    return {
      id: a.id,
      meetingId: a.meetingId,
      meetingReference: ref(r.meetingNumber),
      title: a.title,
      ownerAccountId: a.ownerId,
      ownerName: r.ownerName,
      dueOn: fromDate(a.dueOn),
      status: a.status as ActionStatus,
      overdue: r.overdue,
      doneAt: a.doneAt,
      doneNote: a.doneNote,
      cancelledAt: a.cancelledAt,
      cancelReason: a.cancelReason,
      createdAt: a.createdAt,
    };
  }
}

/** A meeting in a list. */
export class MeetingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'BM-0001' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  termId: string;
  @ApiProperty({ enum: MEETING_KINDS, enumName: 'BoardMeetingKind' })
  kind: MeetingKind;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, nullable: true })
  location: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  scheduledAt: Date;
  @ApiProperty({ enum: MEETING_STATUSES, enumName: 'BoardMeetingStatus' })
  status: MeetingStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  heldAt: Date | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Seats sitting when it was held.',
  })
  seated: number | null;
  @ApiProperty({ type: Number, nullable: true })
  present: number | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'More than half of the seats were present.',
  })
  quorate: boolean | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The board publication holding its minutes.',
  })
  minutesPublicationId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From `boardMeetingCancel`, once cancelled.',
  })
  cancelReason: string | null;
  @ApiProperty({ enum: ['manager', 'board'] })
  authorSide: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(m: BoardMeeting): MeetingView {
    return {
      id: m.id,
      reference: ref(m.number),
      termId: m.termId,
      kind: m.kind as MeetingKind,
      title: m.title,
      location: m.location,
      scheduledAt: m.scheduledAt,
      status: m.status as MeetingStatus,
      heldAt: m.heldAt,
      seated: m.seatedCount,
      present: m.presentCount,
      quorate: m.quorate,
      minutesPublicationId: m.minutesPublicationId,
      cancelledAt: m.cancelledAt,
      cancelReason: m.cancelReason,
      authorSide: m.authorSide,
      createdAt: m.createdAt,
    };
  }
}

/** A meeting with its agenda, attendance, action items and what to follow up. */
export class MeetingDetailView extends MeetingView {
  @ApiProperty({ type: [MeetingAgendaItemView] })
  agenda: MeetingAgendaItemView[];
  @ApiProperty({
    type: [MeetingAttendanceView],
    description: 'Every seat sitting when it was held; empty before.',
  })
  attendance: MeetingAttendanceView[];
  @ApiProperty({ type: [MeetingActionView] })
  actions: MeetingActionView[];
  @ApiProperty({
    type: [MeetingActionView],
    description:
      'Open action items of the same board’s earlier meetings: the decisions to follow up.',
  })
  followUp: MeetingActionView[];

  static fromRecord(r: MeetingRecord): MeetingDetailView {
    return {
      ...MeetingView.from(r.meeting),
      agenda: r.agenda.map((i) => MeetingAgendaItemView.from(i)),
      attendance: r.attendance.map((a) => MeetingAttendanceView.from(a)),
      actions: r.actions.map((a) => MeetingActionView.from(a)),
      followUp: r.followUp.map((a) => MeetingActionView.from(a)),
    };
  }
}
