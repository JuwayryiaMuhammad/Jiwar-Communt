import { ApiProperty } from '@nestjs/swagger';
import {
  GateDecisionSource,
  GateRequestKind,
  GateRequestStatus,
} from '@prisma/client';
import { StandingInstructionAction } from '@prisma/client';
import type { GuardRequestView, HostRequestView } from '../approvals.service';
import { STANDING_ACTION_DOC } from '../../visitors/dto/visitors.dto';

/** What the guard sees of a standing instruction (ADR 0043). */
export class GuardInstructionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description:
      'As the household wrote it. Personal: shown while the request waits.',
  })
  description: string;
  @ApiProperty({
    enum: StandingInstructionAction,
    enumName: 'StandingInstructionAction',
    description:
      STANDING_ACTION_DOC +
      '\n\nAn `always_allow` the compound does not allow reads `call_first`.',
  })
  action: StandingInstructionAction;
}

/** For the guard: never who decided, never a resident. */
export class GuardRequestResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: GateRequestKind, enumName: 'GateRequestKind' })
  kind: GateRequestKind;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: Number })
  partySize: number;
  @ApiProperty({ enum: GateRequestStatus, enumName: 'GateRequestStatus' })
  status: GateRequestStatus;
  @ApiProperty({
    enum: GateDecisionSource,
    enumName: 'GateDecisionSource',
    nullable: true,
  })
  decisionSource: GateDecisionSource | null;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({
    type: [GuardInstructionView],
    description:
      "A waiting visitor or delivery: the unit's standing instructions whose author may still invite there (ADR 0043). Empty once decided, and for a worker.",
  })
  standingInstructions: GuardInstructionView[];

  static from(r: GuardRequestView): GuardRequestResponse {
    return {
      id: r.id,
      kind: r.kind,
      unitCode: r.unitCode,
      partySize: r.partySize,
      status: r.status,
      decisionSource: r.decisionSource,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      standingInstructions: r.standingInstructions.map((i) => ({
        id: i.id,
        description: i.description,
        action: i.action,
      })),
    };
  }
}

/** For the household: never the guard. */
export class HostRequestResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: GateRequestKind, enumName: 'GateRequestKind' })
  kind: GateRequestKind;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  gateName: string;
  @ApiProperty({ type: Number })
  partySize: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'As the guard typed it; gone when the data expires.',
  })
  visitorName: string | null;
  @ApiProperty({ type: String, nullable: true })
  workerName: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: HostRequestView): HostRequestResponse {
    return {
      id: r.id,
      kind: r.kind,
      unitId: r.unitId,
      unitCode: r.unitCode,
      gateName: r.gateName,
      partySize: r.partySize,
      visitorName: r.visitorName,
      workerName: r.workerName,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    };
  }
}

export class DecisionResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: GateRequestStatus, enumName: 'GateRequestStatus' })
  status: GateRequestStatus;
  @ApiProperty({
    enum: GateDecisionSource,
    enumName: 'GateDecisionSource',
    nullable: true,
  })
  decisionSource: GateDecisionSource | null;
}
