import { ApiProperty } from '@nestjs/swagger';
import {
  GateDecisionSource,
  GateRequestKind,
  GateRequestStatus,
} from '@prisma/client';
import type { GuardRequestView, HostRequestView } from '../approvals.service';

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
