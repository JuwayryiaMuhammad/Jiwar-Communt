import { ApiProperty } from '@nestjs/swagger';
import { EmergencyStatus, EmergencyType } from '@prisma/client';
import {
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { PostView } from '../../roster/views/roster.views';
import { minutesAway, safetyReference } from '../../safety/safety-rules';
import type { EmergencyRecord } from '../emergency-records';
import {
  EmergencyLocationView,
  responderOf,
  ResponderView,
  timeline,
  TimelineStepView,
} from './emergency.views';

/**
 * An emergency as the responders and the management see it (ADR 0047):
 * where, what, who reported it (a first name), who answers. Never a
 * resident's phone.
 */
export class StaffEmergencyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'E-0042' })
  reference: string;
  @ApiProperty({ enum: EmergencyType, enumName: 'EmergencyType' })
  type: EmergencyType;
  @ApiProperty({ enum: EmergencyStatus, enumName: 'EmergencyStatus' })
  status: EmergencyStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  reportedAt: Date;
  @ApiProperty({
    type: EmergencyLocationView,
    nullable: true,
    description: 'The unit it came from; null for a guard’s SOS.',
  })
  location: EmergencyLocationView | null;
  @ApiProperty({
    type: PostView,
    nullable: true,
    description:
      'A guard’s SOS (ADR 0053): the gate or the zone it was raised at; null for a unit’s emergency.',
  })
  post: PostView | null;
  @ApiProperty({ type: FirstNameRefView })
  reportedBy: FirstNameRefView;
  @ApiProperty({
    type: FirstNameRefView,
    nullable: true,
    description: 'Who accepted it.',
  })
  responderAccount: FirstNameRefView | null;
  @ApiProperty({
    type: ResponderView,
    nullable: true,
    description: 'What the household sees of the responder.',
  })
  responder: ResponderView | null;
  @ApiProperty({
    type: Boolean,
    description: 'The caller is its responder.',
  })
  isMine: boolean;
  @ApiProperty({ type: Number, nullable: true, enum: [2, 5, 10, 15] })
  etaMinutes: number | null;
  @ApiProperty({ type: Number, nullable: true })
  minutesAway: number | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Handed to the management: nobody accepted in time, or nobody was there to tell.',
  })
  escalatedAt: Date | null;
  @ApiProperty({
    enum: ['timeout', 'no_responders'],
    nullable: true,
  })
  escalationReason: string | null;
  @ApiProperty({ type: Number, description: 'Responders told at the report.' })
  respondersNotified: number;
  @ApiProperty({ type: Number })
  familyNotified: number;
  @ApiProperty({ type: Number })
  familyOnTheWay: number;
  @ApiProperty({ type: [TimelineStepView] })
  timeline: TimelineStepView[];
  @ApiProperty({ type: String, nullable: true })
  closeReason: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The resolving staff’s note.',
  })
  closeNote: string | null;

  static from(r: EmergencyRecord, me: string): StaffEmergencyView {
    const e = r.emergency;
    return {
      id: e.id,
      reference: safetyReference('E', e.number),
      type: e.type,
      status: e.status,
      reportedAt: e.reportedAt,
      location: r.location && { ...r.location },
      post: r.post,
      reportedBy: firstNameRef(r.reporter),
      responderAccount: r.responder && firstNameRef(r.responder),
      responder: responderOf(r),
      isMine: e.responderId === me,
      etaMinutes: e.etaMinutes,
      minutesAway: minutesAway(e, r.now),
      escalatedAt: e.escalatedAt,
      escalationReason: e.escalationReason,
      respondersNotified: e.respondersNotified,
      familyNotified: r.alerts.length,
      familyOnTheWay: r.alerts.filter((a) => a.onMyWayAt).length,
      timeline: timeline(r),
      closeReason: e.closeReason,
      closeNote: e.closeNote,
    };
  }
}
