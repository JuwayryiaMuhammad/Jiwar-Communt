import { ApiProperty } from '@nestjs/swagger';
import type { CallJoin, GateCallRead } from '../gate-calls.service';

const STATUSES = ['ringing', 'answered', 'declined', 'missed', 'ended'];
const END_REASONS = [
  'guard',
  'resident',
  'declined',
  'missed',
  'max_duration',
  'shift_ended',
  'vendor',
  'unavailable',
];

/**
 * A gate call as the guard reads it (ADR 0068): whether the household
 * answered — never who, never a number.
 */
export class GuardGateCallView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  reasonCode: string;
  @ApiProperty({ enum: STATUSES, enumName: 'GateCallStatus' })
  status: string;
  @ApiProperty({ type: Boolean, description: 'The household answered.' })
  answered: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  answeredAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({
    enum: END_REASONS,
    enumName: 'GateCallEndReason',
    nullable: true,
  })
  endReason: string | null;

  static from(r: GateCallRead): GuardGateCallView {
    const c = r.call;
    return {
      id: c.id,
      unitId: c.unitId,
      unitCode: r.unitCode,
      reasonCode: c.reasonCode,
      status: c.status,
      answered: c.answeredAt !== null,
      startedAt: c.startedAt,
      answeredAt: c.answeredAt,
      endedAt: c.endedAt,
      endReason: c.endReason,
    };
  }
}

/** A gate call as the household reads it: from which gate, and why. */
export class ResidentGateCallView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  gateName: string;
  @ApiProperty({ type: String })
  reasonCode: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  approvalRequestId: string | null;
  @ApiProperty({ enum: STATUSES, enumName: 'GateCallStatus' })
  status: string;
  @ApiProperty({ type: Boolean, description: 'You took it.' })
  answeredByMe: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  static from(r: GateCallRead, me: string): ResidentGateCallView {
    const c = r.call;
    return {
      id: c.id,
      gateName: r.gateName,
      reasonCode: c.reasonCode,
      approvalRequestId: c.approvalRequestId,
      status: c.status,
      answeredByMe: c.answeredByAccountId === me,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
    };
  }
}

/** A short-lived token to join the call's room in the app. Never stored. */
export class GateCallJoinView {
  @ApiProperty({ type: String })
  token: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(j: CallJoin): GateCallJoinView {
    return { token: j.token, expiresAt: j.expiresAt };
  }
}

export class AnsweredGateCallView {
  @ApiProperty({ type: ResidentGateCallView })
  call: ResidentGateCallView;
  @ApiProperty({ type: GateCallJoinView })
  join: GateCallJoinView;
}
