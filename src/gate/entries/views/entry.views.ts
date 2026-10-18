import { ApiProperty } from '@nestjs/swagger';
import {
  GateDirection,
  GateEntryMethod,
  GateSubjectType,
} from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import type {
  EntryListItem,
  EntryRecord,
  InsideItem,
} from '../entries.service';
import { PresignedReadView } from '../../../core/files/views/file.views';
import type { VerifyDisplay, VerifyResult } from '../verify.service';
import { GuardParkingView } from '../../vehicles/views/plate-lookup.views';

const REASONS = [
  'unknown_code',
  'not_yet_valid',
  'expired',
  'outside_schedule',
  'host_inactive',
  'used',
  'cancelled',
  'suspended',
  'ended',
  'banned',
  'not_approved',
  'expired_qr',
  'not_resident',
  'account_inactive',
  'revoked',
  // Permits (ADR 0049).
  'outside_work_hours',
  'day_off',
  'id_mismatch',
  'worker_removed',
  'guest_removed',
  // Lockdown and the blocklist (ADR 0053).
  'lockdown_active',
  'entry_blocked',
];

/** The blocklist entry a verify met (ADR 0053). */
export class VerifyBlocklistView {
  @ApiProperty({ type: String, format: 'uuid' })
  entryId: string;
  @ApiProperty({ enum: ['ban', 'watch'], enumName: 'BlocklistKind' })
  kind: 'ban' | 'watch';
}

export class VerifyDisplayView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A pass or a worker: their unit. Null for a resident.',
  })
  unitCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  passKind: string | null;
  @ApiProperty({ type: Number, nullable: true })
  partySize: number | null;
  @ApiProperty({ type: String, nullable: true })
  workerName: string | null;
  @ApiProperty({ type: String, nullable: true })
  capacity: string | null;
  @ApiProperty({
    type: PresignedReadView,
    nullable: true,
    description:
      "A valid worker's photo, to compare the face (ADR 0029); null otherwise.",
  })
  photo: PresignedReadView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A valid resident: the first word of their name, never the full name (ADR 0031). Null otherwise.',
  })
  firstName: string | null;
  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'A valid resident: the codes of the units where they live now. Null otherwise.',
  })
  unitCodes: string[] | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "A valid resident's photo (a short-lived presigned URL), or null when they have none: ask for ID. Null otherwise.",
  })
  photoUrl: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "A valid visitor pass's vehicle plate, as the host typed it (ADR 0043). Null otherwise.",
  })
  vehiclePlate: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'A one-time pass: how many of its `partySize` came in (ADR 0043). The code lets the rest in until it reaches `partySize` or the pass ends. Null otherwise.',
  })
  entriesUsed: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'A visitor pass: how many on it are inside now. `next` is `in` while there is room and the pass is valid, else `out` while anyone is inside. Null otherwise.',
  })
  insideCount: number | null;

  @ApiProperty({
    type: GuardParkingView,
    nullable: true,
    description:
      'A valid visitor pass’s parking booking (ADR 0045): holding now, or the next within two hours. Null otherwise.',
  })
  parking: GuardParkingView | null;

  @ApiProperty({
    type: VerifyBlocklistView,
    nullable: true,
    description:
      'A pass whose visitor’s plate is on the blocklist (ADR 0053): a `ban` (refused, `entry_blocked`) or a `watch` (let in, the management told). Open the entry in the active list for the face; never why.',
  })
  blocklist: VerifyBlocklistView | null;

  static from(d: VerifyDisplay): VerifyDisplayView {
    return {
      unitCode: d.unitCode,
      passKind: d.passKind,
      partySize: d.partySize,
      workerName: d.workerName,
      capacity: d.capacity,
      photo: PresignedReadView.from(d.photo),
      firstName: d.firstName,
      unitCodes: d.unitCodes,
      photoUrl: d.photoUrl,
      vehiclePlate: d.vehiclePlate,
      entriesUsed: d.entriesUsed,
      insideCount: d.insideCount,
      parking: GuardParkingView.from(d.parking),
      blocklist: d.blocklist && { ...d.blocklist },
    };
  }
}

export class VerifyView {
  @ApiProperty({ enum: ['valid', 'invalid'] })
  result: 'valid' | 'invalid';
  @ApiProperty({ enum: ['visitor', 'worker', 'resident'], nullable: true })
  subject: 'visitor' | 'worker' | 'resident' | null;
  @ApiProperty({ enum: REASONS, nullable: true })
  reason: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Record the entry with it; for a worker outside the schedule, ask the household.',
  })
  subjectId: string | null;
  @ApiProperty({ enum: ['in', 'out'], nullable: true })
  next: 'in' | 'out' | null;
  @ApiProperty({
    type: VerifyDisplayView,
    nullable: true,
    description:
      "Null for an unknown code and for any invalid resident result. A resident's is the first name, the unit codes and the photo (ADR 0031); never a visitor name.",
  })
  display: VerifyDisplayView | null;

  static from(v: VerifyResult): VerifyView {
    return {
      result: v.result,
      subject: v.subject,
      reason: v.reason,
      subjectId: v.subjectId,
      next: v.next,
      display: v.display ? VerifyDisplayView.from(v.display) : null,
    };
  }
}

export class EntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: GateSubjectType, enumName: 'GateSubjectType' })
  subjectType: GateSubjectType;
  @ApiProperty({ type: String, format: 'uuid' })
  subjectId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: GateDirection, enumName: 'GateDirection' })
  direction: GateDirection;
  @ApiProperty({ enum: GateEntryMethod, enumName: 'GateEntryMethod' })
  method: GateEntryMethod;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt: Date;

  static from(e: EntryRecord): EntryView {
    return {
      id: e.id,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      unitCode: e.unitCode,
      direction: e.direction,
      method: e.method,
      occurredAt: e.occurredAt,
      recordedAt: e.recordedAt,
    };
  }
}

export class EntryListView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  gateId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  shiftId: string | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null for a system entry (an unconfirmed exit).',
  })
  guard: AccountRefView | null;
  @ApiProperty({ enum: GateSubjectType, enumName: 'GateSubjectType' })
  subjectType: GateSubjectType;
  @ApiProperty({ type: String, format: 'uuid' })
  subjectId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: GateDirection, enumName: 'GateDirection' })
  direction: GateDirection;
  @ApiProperty({ enum: GateEntryMethod, enumName: 'GateEntryMethod' })
  method: GateEntryMethod;
  @ApiProperty({ type: Boolean })
  unconfirmed: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt: Date;

  static from(e: EntryListItem): EntryListView {
    return {
      id: e.id,
      gateId: e.gateId,
      shiftId: e.shiftId,
      guard: e.guard ? accountRef(e.guard) : null,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      unitId: e.unitId,
      unitCode: e.unitCode,
      direction: e.direction,
      method: e.method,
      unconfirmed: e.unconfirmed,
      occurredAt: e.occurredAt,
      recordedAt: e.recordedAt,
    };
  }
}

export class InsideView {
  @ApiProperty({ enum: GateSubjectType, enumName: 'GateSubjectType' })
  subjectType: GateSubjectType;
  @ApiProperty({ type: String, format: 'uuid' })
  subjectId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({
    type: String,
    description:
      'The pass kind, the worker capacity or the request kind; `contractor`, `event_guest` or `move` for a permit’s subject (ADR 0049).',
  })
  kind: string;
  @ApiProperty({ type: Number })
  partySize: number;
  @ApiProperty({
    type: Number,
    description:
      'How many on this subject are inside now: a group pass lets in one person per entry (ADR 0043); 1 for everyone else.',
  })
  insideCount: number;
  @ApiProperty({ type: String })
  gateName: string;
  @ApiProperty({ type: String, format: 'date-time' })
  enteredAt: Date;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'A permit’s subject (ADR 0049): its permit, to open for the names. Never a name here.',
  })
  permitId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'W-0042' })
  permitReference: string | null;

  static from(i: InsideItem): InsideView {
    return {
      subjectType: i.subjectType,
      subjectId: i.subjectId,
      unitCode: i.unitCode,
      kind: i.kind,
      partySize: i.partySize,
      insideCount: i.insideCount,
      gateName: i.gateName,
      enteredAt: i.enteredAt,
      permitId: i.permitId,
      permitReference: i.permitReference,
    };
  }
}
