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
];

export class VerifyDisplayView {
  @ApiProperty({ type: String })
  unitCode: string;
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

  static from(d: VerifyDisplay): VerifyDisplayView {
    return {
      unitCode: d.unitCode,
      passKind: d.passKind,
      partySize: d.partySize,
      workerName: d.workerName,
      capacity: d.capacity,
      photo: PresignedReadView.from(d.photo),
    };
  }
}

export class VerifyView {
  @ApiProperty({ enum: ['valid', 'invalid'] })
  result: 'valid' | 'invalid';
  @ApiProperty({ enum: ['visitor', 'worker'], nullable: true })
  subject: 'visitor' | 'worker' | null;
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
      'Null for an unknown code. Never a visitor name or a resident.',
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
    description: 'The pass kind, the worker capacity or the request kind.',
  })
  kind: string;
  @ApiProperty({ type: Number })
  partySize: number;
  @ApiProperty({ type: String })
  gateName: string;
  @ApiProperty({ type: String, format: 'date-time' })
  enteredAt: Date;

  static from(i: InsideItem): InsideView {
    return {
      subjectType: i.subjectType,
      subjectId: i.subjectId,
      unitCode: i.unitCode,
      kind: i.kind,
      partySize: i.partySize,
      gateName: i.gateName,
      enteredAt: i.enteredAt,
    };
  }
}
