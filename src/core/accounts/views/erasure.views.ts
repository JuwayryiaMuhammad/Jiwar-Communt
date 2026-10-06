import { ApiProperty } from '@nestjs/swagger';
import type {
  ErasureScope,
  LegalHoldView,
  PendingErasure,
} from '../account-deletion.service';

/**
 * An open deletion request (pending, or queued with its blockers), for the
 * erasure staff: ids, dates and codes only.
 */
export class PendingErasureView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({
    enum: ['pending', 'cancelled', 'completed', 'queued', 'closed'],
    enumName: 'DeletionRequestStatus',
  })
  status: PendingErasure['status'];
  @ApiProperty({
    type: [String],
    description:
      'Queued: what blocked the erasure (primary_resident, active_staff_role, legal_hold, open_worker_obligations).',
  })
  blockers: string[];
  @ApiProperty({ type: Boolean, description: 'Filed by the management.' })
  assisted: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  effectiveAt: Date;
  @ApiProperty({
    type: Number,
    description: 'Days since the grace period ended; negative while in grace.',
  })
  daysOverdue: number;
  @ApiProperty({ type: Boolean })
  onLegalHold: boolean;

  static from(p: PendingErasure): PendingErasureView {
    return {
      id: p.id,
      accountId: p.accountId,
      status: p.status,
      blockers: [...p.blockers],
      assisted: p.assisted,
      requestedAt: p.requestedAt,
      effectiveAt: p.effectiveAt,
      daysOverdue: p.daysOverdue,
      onLegalHold: p.onLegalHold,
    };
  }
}

export class ErasedCountsView {
  @ApiProperty({ type: [String] })
  personalFields: string[];
  @ApiProperty({ type: Number })
  activeOccupancies: number;
  @ApiProperty({ type: Number })
  activeMemberships: number;
  @ApiProperty({ type: Number })
  workerEngagementsRequested: number;
  @ApiProperty({ type: Number })
  sessions: number;
  @ApiProperty({ type: Number })
  pendingMessages: number;
  @ApiProperty({ type: Number })
  invitesAccepted: number;
}

export class KeptCountsView {
  @ApiProperty({
    type: Number,
    description: 'They stay, pointing at a deleted user.',
  })
  auditEntries: number;
}

/** Step 1 of 3: what goes and what stays, and the phrase step 3 must type. */
export class ErasureScopeView {
  @ApiProperty({ type: String, format: 'uuid' })
  requestId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, description: 'Step 3 types exactly this.' })
  scopePhrase: string;
  @ApiProperty({ type: ErasedCountsView })
  erased: ErasedCountsView;
  @ApiProperty({ type: KeptCountsView })
  kept: KeptCountsView;

  static from(s: ErasureScope): ErasureScopeView {
    return {
      requestId: s.requestId,
      accountId: s.accountId,
      scopePhrase: s.scopePhrase,
      erased: {
        personalFields: [...s.erased.personalFields],
        activeOccupancies: s.erased.activeOccupancies,
        activeMemberships: s.erased.activeMemberships,
        workerEngagementsRequested: s.erased.workerEngagementsRequested,
        sessions: s.erased.sessions,
        pendingMessages: s.erased.pendingMessages,
        invitesAccepted: s.erased.invitesAccepted,
      },
      // The service's `note` is English display text: never sent (ADR 0013).
      kept: { auditEntries: s.kept.auditEntries },
    };
  }
}

/** An active hold: its code only; the note stays on the record. */
export class LegalHoldResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String })
  reasonCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  placedAt: Date;

  static from(h: LegalHoldView): LegalHoldResponse {
    return {
      id: h.id,
      accountId: h.accountId,
      reasonCode: h.reasonCode,
      placedAt: h.placedAt,
    };
  }
}

export class IdView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
}
