import { ApiProperty } from '@nestjs/swagger';
import type { GovernanceAgendaProposal } from '@prisma/client';
import { AGENDA_STATUSES, type AgendaStatus } from './agenda.service';

/** An agenda proposal (ADR 0059), as its proposer and the board read it. */
export class AgendaProposalView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once cleared by the proposer’s erasure.',
  })
  title: string | null;
  @ApiProperty({ type: String, nullable: true })
  body: string | null;
  @ApiProperty({ enum: AGENDA_STATUSES, enumName: 'AgendaProposalStatus' })
  status: AgendaStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.agendaDecline, when declined.',
  })
  declineReason: string | null;
  @ApiProperty({ type: String, nullable: true })
  decisionNote: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt: Date | null;

  static from(p: GovernanceAgendaProposal): AgendaProposalView {
    return {
      id: p.id,
      title: p.title,
      body: p.body,
      status: p.status as AgendaStatus,
      createdAt: p.createdAt,
      decidedAt: p.decidedAt,
      declineReason: p.declineReason,
      decisionNote: p.decisionNote,
      withdrawnAt: p.withdrawnAt,
    };
  }
}
