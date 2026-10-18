import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { PresignedReadView } from '../../../core/files/views/file.views';
import { PlaceView } from '../../places/views/place.views';
import { PostView } from '../../roster/views/roster.views';
import { safetyReference } from '../../safety/safety-rules';
import type { IncidentRecord } from '../incidents.service';

const STATUSES = ['open', 'investigating', 'closed'] as const;

export class IncidentUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
}

export class IncidentLinksView {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  emergencyId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  gateServiceRequestId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  patrolNoteId: string | null;
}

/**
 * An incident as its author, a guard, reads it (ADR 0053): what they
 * reported, its status and outcome, and whether it was acknowledged. Never
 * the investigator, the internal notes or the closing note.
 */
export class GuardIncidentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'I-0042' })
  reference: string;
  @ApiProperty({
    enum: [...REASON_CODES.incidentType],
    enumName: 'IncidentType',
  })
  type: string;
  @ApiProperty({
    enum: [...REASON_CODES.incidentSeverity],
    enumName: 'IncidentSeverity',
  })
  severity: string;
  @ApiProperty({ enum: STATUSES, enumName: 'IncidentStatus' })
  status: string;
  @ApiProperty({ type: PlaceView, nullable: true })
  place: PlaceView | null;
  @ApiProperty({ type: IncidentUnitView, nullable: true })
  unit: IncidentUnitView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  reportedAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The author’s words; null once their account was erased.',
  })
  description: string | null;
  @ApiProperty({ type: [PresignedReadView] })
  photos: PresignedReadView[];
  @ApiProperty({ type: IncidentLinksView })
  links: IncidentLinksView;
  @ApiProperty({
    enum: [...REASON_CODES.incidentOutcome],
    enumName: 'IncidentOutcome',
    nullable: true,
  })
  outcome: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the author acknowledged it.',
  })
  authorAcknowledgedAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When a reviewer acknowledged it.',
  })
  reviewerAcknowledgedAt: Date | null;

  static from(r: IncidentRecord): GuardIncidentView {
    const i = r.incident;
    const ackAt = (role: string) =>
      r.acknowledgements.find((a) => a.ack.role === role)?.ack.acknowledgedAt ??
      null;
    return {
      id: i.id,
      reference: safetyReference('I', i.number),
      type: i.type,
      severity: i.severity,
      status: i.status,
      place: r.place && { ...r.place },
      unit: r.unit && { ...r.unit },
      occurredAt: i.occurredAt,
      reportedAt: i.createdAt,
      description: i.description,
      photos: r.photos.map((p) => ({ url: p.url, expiresAt: p.expiresAt })),
      links: {
        emergencyId: i.emergencyId,
        gateServiceRequestId: i.gateServiceRequestId,
        patrolNoteId: i.patrolNoteId,
      },
      outcome: i.outcome,
      closedAt: i.closedAt,
      authorAcknowledgedAt: ackAt('author'),
      reviewerAcknowledgedAt: ackAt('reviewer'),
    };
  }
}

export class IncidentNoteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView })
  author: AccountRefView;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its author’s account was erased.',
  })
  body: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
}

export class IncidentAcknowledgementView {
  @ApiProperty({ enum: ['author', 'reviewer'] })
  role: string;
  @ApiProperty({ type: AccountRefView })
  account: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
}

/**
 * An incident as the management keeps it (`incidents.manage`): everything
 * the author sees, and who reported it, where they were on shift, the
 * investigator, the internal notes, the closing note and who closed it.
 */
export class StaffIncidentView extends GuardIncidentView {
  @ApiProperty({ type: AccountRefView })
  reportedBy: AccountRefView;
  @ApiProperty({
    type: PostView,
    nullable: true,
    description: 'A guard’s report: the post of their shift.',
  })
  post: PostView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  investigator: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  assignedAt: Date | null;
  @ApiProperty({ type: [IncidentNoteView] })
  notes: IncidentNoteView[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The closer’s words; null once their account was erased.',
  })
  closingNote: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  closedBy: AccountRefView | null;
  @ApiProperty({ type: [IncidentAcknowledgementView] })
  acknowledgements: IncidentAcknowledgementView[];

  static from(r: IncidentRecord): StaffIncidentView {
    const i = r.incident;
    return {
      ...GuardIncidentView.from(r),
      reportedBy: accountRef(r.reportedBy),
      post: r.post,
      investigator: r.investigator && accountRef(r.investigator),
      assignedAt: i.assignedAt,
      notes: r.notes.map((n) => ({
        id: n.note.id,
        author: accountRef(n.author),
        body: n.note.body,
        at: n.note.createdAt,
      })),
      closingNote: i.closingNote,
      closedBy: r.closedBy && accountRef(r.closedBy),
      acknowledgements: r.acknowledgements.map((a) => ({
        role: a.ack.role,
        account: accountRef(a.account),
        at: a.ack.acknowledgedAt,
      })),
    };
  }
}
