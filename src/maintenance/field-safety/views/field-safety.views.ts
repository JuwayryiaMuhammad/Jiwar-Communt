import { ApiProperty } from '@nestjs/swagger';
import type {
  SafetyAcknowledgement,
  SafetyInstruction,
  WorkPermit,
} from '@prisma/client';
import { REASON_CODES } from '../../../core/common/reasons';
import type { TicketSafety } from '../safety-instructions.service';
import { HAZARDS, WORK_PERMIT_STATUSES } from '../safety-rules';
import type { TicketPermits } from '../work-permits.service';

export class WorkPermitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({ enum: HAZARDS, enumName: 'WorkHazard' })
  hazard: string;
  @ApiProperty({ type: String })
  precautions: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ enum: WORK_PERMIT_STATUSES, enumName: 'WorkPermitStatus' })
  status: string;
  @ApiProperty({ type: String, format: 'uuid' })
  requestedById: string;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.workPermitReject,
    enumName: 'WorkPermitRejectReason',
    nullable: true,
  })
  rejectReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.workPermitRevoke,
    enumName: 'WorkPermitRevokeReason',
    nullable: true,
  })
  revokeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;

  static from(p: WorkPermit): WorkPermitView {
    return {
      id: p.id,
      ticketId: p.ticketId,
      cycle: p.cycle,
      hazard: p.hazard,
      precautions: p.precautions,
      expiresAt: p.expiresAt,
      status: p.status,
      requestedById: p.requestedById,
      requestedAt: p.requestedAt,
      decidedAt: p.decidedAt,
      rejectReason: p.rejectReason,
      revokedAt: p.revokedAt,
      revokeReason: p.revokeReason,
      closedAt: p.closedAt,
    };
  }
}

export class TicketPermitsView {
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({
    enum: HAZARDS,
    enumName: 'WorkHazard',
    isArray: true,
    description:
      'What its work needs a permit for: its category’s and its asset type’s.',
  })
  hazards: string[];
  @ApiProperty({ type: [WorkPermitView], description: 'This cycle’s.' })
  permits: WorkPermitView[];

  static from(t: TicketPermits): TicketPermitsView {
    return {
      ticketId: t.ticketId,
      cycle: t.cycle,
      hazards: [...t.hazards],
      permits: t.permits.map((p) => WorkPermitView.from(p)),
    };
  }
}

export class SafetyInstructionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  categoryId: string;
  @ApiProperty({ type: Number })
  version: number;
  @ApiProperty({ type: String })
  textEn: string;
  @ApiProperty({ type: String })
  textAr: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(i: SafetyInstruction): SafetyInstructionView {
    return {
      id: i.id,
      categoryId: i.categoryId,
      version: i.version,
      textEn: i.textEn,
      textAr: i.textAr,
      createdAt: i.createdAt,
    };
  }
}

export class SafetyAcknowledgementView {
  @ApiProperty({ type: String, format: 'uuid' })
  instructionId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: Number })
  cycle: number;
  @ApiProperty({
    type: String,
    description:
      'SHA-256 of what was shown, with who, the ticket and the cycle.',
  })
  contentSha256: string;
  @ApiProperty({ type: String, format: 'date-time' })
  acknowledgedAt: Date;

  static from(a: SafetyAcknowledgement): SafetyAcknowledgementView {
    return {
      instructionId: a.instructionId,
      ticketId: a.ticketId,
      cycle: a.cycle,
      contentSha256: a.contentSha256,
      acknowledgedAt: a.acknowledgedAt,
    };
  }
}

export class TicketSafetyView {
  @ApiProperty({ type: SafetyInstructionView, nullable: true })
  instruction: SafetyInstructionView | null;
  @ApiProperty({ type: SafetyAcknowledgementView, nullable: true })
  acknowledgement: SafetyAcknowledgementView | null;

  static from(t: TicketSafety): TicketSafetyView {
    return {
      instruction: t.instruction
        ? SafetyInstructionView.from(t.instruction)
        : null,
      acknowledgement: t.acknowledgement
        ? SafetyAcknowledgementView.from(t.acknowledgement)
        : null,
    };
  }
}

export class HazardsView {
  @ApiProperty({ enum: HAZARDS, enumName: 'WorkHazard', isArray: true })
  hazards: string[];
}
