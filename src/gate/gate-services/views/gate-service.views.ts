import { ApiProperty } from '@nestjs/swagger';
import { GateServiceKind, GateServiceStatus } from '@prisma/client';
import {
  firstNameOf,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { ResponderView } from '../../emergencies/views/emergency.views';
import { PlaceView } from '../../places/views/place.views';
import {
  minutesAway,
  safetyReference,
  seriesOf,
} from '../../safety/safety-rules';
import type { GateServiceRecord } from '../gate-service-records';

export class ServiceGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'Main gate' })
  name: string;
}

export class ServiceMemberView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  firstName: string | null;
}

const place = (r: GateServiceRecord, id: string | null) => {
  const p = id ? r.places.get(id) : undefined;
  return p ? PlaceView.from(p) : null;
};

/** What every view of a request shows (ADR 0047). */
export class GateServiceBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    example: 'S-0042',
    description: 'A- for accessibility help, S- for the other services.',
  })
  reference: string;
  @ApiProperty({ enum: GateServiceKind, enumName: 'GateServiceKind' })
  kind: GateServiceKind;
  @ApiProperty({
    enum: GateServiceStatus,
    enumName: 'GateServiceStatus',
    description:
      '`open`: waiting for security; `accepted`: someone is coming; `in_progress`: being done; `closed`; `cancelled` (by the requester while open, or because the requester left).',
  })
  status: GateServiceStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({
    enum: [...REASON_CODES.assistanceKind],
    enumName: 'AssistanceKind',
    nullable: true,
    description: 'accessibility only.',
  })
  assistanceKind: string | null;
  @ApiProperty({
    type: ServiceMemberView,
    nullable: true,
    description:
      'accessibility only: the household member helped; null for the requester.',
  })
  member: ServiceMemberView | null;
  @ApiProperty({
    type: PlaceView,
    nullable: true,
    description: 'accessibility and escort.',
  })
  fromPlace: PlaceView | null;
  @ApiProperty({
    type: PlaceView,
    nullable: true,
    description: 'escort; accessibility, where null means the unit.',
  })
  toPlace: PlaceView | null;
  @ApiProperty({
    type: PlaceView,
    nullable: true,
    description: 'suspicious only.',
  })
  place: PlaceView | null;
  @ApiProperty({
    enum: [...REASON_CODES.gateServiceWhen],
    enumName: 'GateServiceWhen',
    nullable: true,
    description: 'accessibility and escort.',
  })
  when: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the help is wanted: the request’s time plus `when`.',
  })
  wantedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'suspicious only; null once the requester was erased.',
  })
  description: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'suspicious only: a presigned URL of the photo, valid for minutes.',
  })
  photoUrl: string | null;
  @ApiProperty({
    enum: [...REASON_CODES.laneReason],
    enumName: 'LaneReason',
    nullable: true,
    description: 'lane only.',
  })
  laneReason: string | null;
  @ApiProperty({
    type: ServiceGateView,
    nullable: true,
    description: 'lane only.',
  })
  gate: ServiceGateView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'lane only; null once the requester was erased.',
  })
  notes: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The minutes security picked, counted down from when they accepted; null before, once closed and when none was given.',
  })
  minutesAway: number | null;
  @ApiProperty({
    type: ResponderView,
    nullable: true,
    description:
      'Who accepted it: a first name and the phone of their gate (else the compound’s duty phone). Never their own.',
  })
  handler: ResponderView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({
    enum: [...REASON_CODES.gateServiceClose],
    enumName: 'GateServiceCloseReason',
    nullable: true,
  })
  closeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;

  static base(r: GateServiceRecord): GateServiceBaseView {
    const q = r.request;
    return {
      id: q.id,
      reference: safetyReference(seriesOf(q.kind).prefix, q.number),
      kind: q.kind,
      status: q.status,
      createdAt: q.createdAt,
      unitId: q.unitId,
      assistanceKind: q.assistanceKind,
      member: r.member && { ...r.member },
      fromPlace: place(r, q.fromPlaceId),
      toPlace: place(r, q.toPlaceId),
      place: place(r, q.placeId),
      when: q.whenCode,
      wantedAt: q.wantedAt,
      description: q.description,
      photoUrl: r.photoUrl,
      laneReason: q.laneReason,
      gate: r.gate && { ...r.gate },
      notes: q.notes,
      minutesAway: minutesAway({ ...q, arrivedAt: null }, r.now),
      handler: r.handler
        ? {
            firstName:
              r.handler.status === 'erased'
                ? null
                : firstNameOf(r.handler.fullName),
            phone: r.handlerPhone,
          }
        : null,
      acceptedAt: q.acceptedAt,
      startedAt: q.startedAt,
      closedAt: q.closedAt,
      closeReason: q.closeReason,
      cancelledAt: q.cancelledAt,
    };
  }
}

/** A request as its requester follows it (ADR 0047, D5). */
export class GateServiceView extends GateServiceBaseView {
  @ApiProperty({
    type: Boolean,
    description: 'Open: the requester may cancel.',
  })
  canCancel: boolean;

  static from(r: GateServiceRecord): GateServiceView {
    return {
      ...GateServiceBaseView.base(r),
      canCancel: r.request.status === 'open',
    };
  }
}

export class ServiceLocationView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
}

/**
 * A request as security and the management see it (ADR 0047): who asked
 * (a first name), from which unit, what they wrote and their photo, who
 * handles it and their note. Never a resident's phone.
 */
export class StaffGateServiceView extends GateServiceBaseView {
  @ApiProperty({ type: ServiceLocationView })
  location: ServiceLocationView;
  @ApiProperty({ type: FirstNameRefView })
  requestedBy: FirstNameRefView;
  @ApiProperty({ type: FirstNameRefView, nullable: true })
  handledBy: FirstNameRefView | null;
  @ApiProperty({ type: Boolean, description: 'The caller handles it.' })
  isMine: boolean;
  @ApiProperty({ type: Number, nullable: true, enum: [2, 5, 10, 15] })
  etaMinutes: number | null;
  @ApiProperty({ type: String, nullable: true })
  closeNote: string | null;
  @ApiProperty({
    enum: ['requester', 'system'],
    nullable: true,
    description: '`system`: the requester was erased.',
  })
  cancelSide: string | null;

  static from(r: GateServiceRecord, me: string): StaffGateServiceView {
    const q = r.request;
    return {
      ...GateServiceBaseView.base(r),
      location: { ...r.location },
      requestedBy: firstNameRef(r.requester),
      handledBy: r.handler && firstNameRef(r.handler),
      isMine: q.handledById === me,
      etaMinutes: q.etaMinutes,
      closeNote: q.closeNote,
      cancelSide: q.cancelSide,
    };
  }
}
