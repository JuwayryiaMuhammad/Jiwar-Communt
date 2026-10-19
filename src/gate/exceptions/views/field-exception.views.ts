import { ApiProperty } from '@nestjs/swagger';
import { REASON_CODES } from '../../../core/common/reasons';
import {
  EXCEPTION_KINDS,
  EXCEPTION_STATUSES,
  type ExceptionKind,
  type ExceptionStatus,
  type ExceptionWorkerType,
} from '../field-exception-rules';
import type {
  GuardExceptionView,
  StaffExceptionView,
} from '../field-exceptions.service';

export class ExceptionWorkerView {
  @ApiProperty({ enum: ['worker_engagement', 'permit_worker'] })
  type: ExceptionWorkerType;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
}

export class ExceptionPersonView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
}

/** A field exception as the guard follows it (ADR 0056): no name, no decider. */
export class GuardFieldExceptionResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'GX-000042' })
  reference: string;
  @ApiProperty({ enum: EXCEPTION_KINDS, enumName: 'GateExceptionKind' })
  kind: ExceptionKind;
  @ApiProperty({ enum: [...REASON_CODES.gateExceptionRaise] })
  reasonCode: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'uuid' })
  gateId: string;
  @ApiProperty({
    enum: EXCEPTION_STATUSES,
    enumName: 'GateExceptionStatus',
    description:
      'A pending one past `answerBy` reads `expired`, whether or not the sweep wrote it yet.',
  })
  status: ExceptionStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  raisedAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Unanswered by then, it expires.',
  })
  answerBy: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    enum: [...REASON_CODES.gateExceptionReject],
    nullable: true,
  })
  rejectReasonCode: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Approved: its one entry, at its gate, until then (`POST /gate/entries` with `subjectType: field_exception`).',
  })
  entryUntil: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  usedAt: Date | null;
  @ApiProperty({
    type: ExceptionWorkerView,
    nullable: true,
    description: 'A worker’s: they come in as themselves, on this exception.',
  })
  worker: ExceptionWorkerView | null;

  static from(v: GuardExceptionView): GuardFieldExceptionResponse {
    return {
      id: v.id,
      reference: v.reference,
      kind: v.kind,
      reasonCode: v.reasonCode,
      unitCode: v.unitCode,
      gateId: v.gateId,
      status: v.status,
      raisedAt: v.raisedAt,
      answerBy: v.answerBy,
      decidedAt: v.decidedAt,
      rejectReasonCode: v.rejectReasonCode,
      entryUntil: v.entryUntil,
      usedAt: v.usedAt,
      worker: v.worker ? { ...v.worker } : null,
    };
  }
}

/** A field exception as the management decides it (ADR 0056). */
export class StaffFieldExceptionResponse extends GuardFieldExceptionResponse {
  @ApiProperty({ type: String })
  gateName: string;
  @ApiProperty({
    type: ExceptionPersonView,
    description: 'The guard who asked.',
  })
  raisedBy: ExceptionPersonView;
  @ApiProperty({ type: ExceptionPersonView, nullable: true })
  decidedBy: ExceptionPersonView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'While the visitor’s data lasts (30 days).',
  })
  visitorName: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'While the visitor’s data lasts (30 days).',
  })
  vehiclePlate: string | null;
  @ApiProperty({ type: String, nullable: true })
  workerName: string | null;

  static fromStaff(v: StaffExceptionView): StaffFieldExceptionResponse {
    return {
      ...GuardFieldExceptionResponse.from(v),
      gateName: v.gateName,
      raisedBy: { ...v.raisedBy },
      decidedBy: v.decidedBy ? { ...v.decidedBy } : null,
      visitorName: v.visitorName,
      vehiclePlate: v.vehiclePlate,
      workerName: v.workerName,
    };
  }
}
