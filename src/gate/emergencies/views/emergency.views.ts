import { ApiProperty } from '@nestjs/swagger';
import { EmergencyStatus, EmergencyType } from '@prisma/client';
import {
  firstNameOf,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { minutesAway, safetyReference } from '../../safety/safety-rules';
import type { EmergencyRecord } from '../emergency-records';
import type { HouseholdEmergency } from '../emergencies.service';

export const TIMELINE_STEPS = [
  'reported',
  'security_notified',
  'management_notified',
  'on_the_way',
  'arrived',
  'family_on_the_way',
  'resolved',
  'cancelled',
] as const;
export type TimelineStep = (typeof TIMELINE_STEPS)[number];

export class EmergencyLocationView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, example: '12' })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true, example: 'Building 7' })
  building: string | null;
}

/** The responder on the way: a first name and the gate's phone. */
export class ResponderView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Their first name; null once erased.',
  })
  firstName: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '+20225550100',
    description:
      'The phone of the gate where they are on shift; for someone not at a gate, the compound’s duty (else emergency) phone. Never their own.',
  })
  phone: string | null;
}

export class TimelineStepView {
  @ApiProperty({
    enum: TIMELINE_STEPS,
    enumName: 'EmergencyTimelineStep',
    description:
      '`security_notified`: responders were told (with the report); `management_notified`: escalated; `family_on_the_way`: one entry per member who answered.',
  })
  step: TimelineStep;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    description: '`family_on_the_way` only: the member’s first name.',
  })
  firstName?: string | null;
}

/** Steps in time order; equal times in the order of TIMELINE_STEPS. */
export function timeline(r: EmergencyRecord): TimelineStepView[] {
  const e = r.emergency;
  const steps: TimelineStepView[] = [{ step: 'reported', at: e.reportedAt }];
  if (e.respondersNotified > 0)
    steps.push({ step: 'security_notified', at: e.reportedAt });
  if (e.escalatedAt)
    steps.push({ step: 'management_notified', at: e.escalatedAt });
  if (e.acceptedAt) steps.push({ step: 'on_the_way', at: e.acceptedAt });
  if (e.arrivedAt) steps.push({ step: 'arrived', at: e.arrivedAt });
  for (const a of r.alerts)
    if (a.onMyWayAt)
      steps.push({
        step: 'family_on_the_way',
        at: a.onMyWayAt,
        firstName:
          a.person.status === 'erased' ? null : firstNameOf(a.person.fullName),
      });
  if (e.closedAt && (e.status === 'resolved' || e.status === 'cancelled'))
    steps.push({ step: e.status, at: e.closedAt });
  return steps
    .map((s, i) => ({ s, i }))
    .sort(
      (x, y) =>
        x.s.at.getTime() - y.s.at.getTime() ||
        TIMELINE_STEPS.indexOf(x.s.step) - TIMELINE_STEPS.indexOf(y.s.step) ||
        x.i - y.i,
    )
    .map(({ s }) => s);
}

export function responderOf(r: EmergencyRecord): ResponderView | null {
  if (!r.responder) return null;
  return {
    firstName:
      r.responder.status === 'erased'
        ? null
        : firstNameOf(r.responder.fullName),
    phone: r.responderPhone,
  };
}

/** An emergency as the household follows it (ADR 0047, C2). */
export class EmergencyView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'E-0042' })
  reference: string;
  @ApiProperty({ enum: EmergencyType, enumName: 'EmergencyType' })
  type: EmergencyType;
  @ApiProperty({
    enum: EmergencyStatus,
    enumName: 'EmergencyStatus',
    description:
      '`reported`: waiting for a responder; `on_the_way`: one accepted; `arrived`; `resolved`; `cancelled` (by the household).',
  })
  status: EmergencyStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  reportedAt: Date;
  @ApiProperty({ type: EmergencyLocationView })
  location: EmergencyLocationView;
  @ApiProperty({ type: FirstNameRefView, description: 'Who reported it.' })
  reportedBy: FirstNameRefView;
  @ApiProperty({ type: ResponderView, nullable: true })
  responder: ResponderView | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The minutes the responder picked, counted down from when they accepted: null before that and once closed, 0 once arrived.',
  })
  minutesAway: number | null;
  @ApiProperty({
    type: Number,
    description: 'How many of the others who live in the unit were told.',
  })
  familyNotified: number;
  @ApiProperty({
    type: Number,
    description: 'How many of them answered “on my way”.',
  })
  familyOnTheWay: number;
  @ApiProperty({ type: [TimelineStepView] })
  timeline: TimelineStepView[];
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Closed: a code of `emergencyResolve` (resolved) or `emergencyCancel` (cancelled, may be null).',
  })
  closeReason: string | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Whether the caller answered “on my way”; null for one who was not alerted (the reporter).',
  })
  onMyWay: boolean | null;
  @ApiProperty({
    type: Boolean,
    description: 'Open, and the caller is its reporter or the unit’s primary.',
  })
  canCancel: boolean;

  static from(r: HouseholdEmergency): EmergencyView {
    const e = r.emergency;
    const open = !e.closedAt;
    return {
      id: e.id,
      reference: safetyReference('E', e.number),
      type: e.type,
      status: e.status,
      reportedAt: e.reportedAt,
      location: { ...r.location },
      reportedBy: firstNameRef(r.reporter),
      responder: responderOf(r),
      minutesAway: minutesAway(e, r.now),
      familyNotified: r.alerts.length,
      familyOnTheWay: r.alerts.filter((a) => a.onMyWayAt).length,
      timeline: timeline(r),
      closeReason: e.closeReason,
      onMyWay: r.viewer.alerted ? r.viewer.onMyWayAt !== null : null,
      canCancel: open && (r.viewer.isReporter || r.viewer.isPrimary),
    };
  }
}
