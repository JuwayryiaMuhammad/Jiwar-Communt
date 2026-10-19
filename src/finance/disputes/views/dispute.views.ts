import { ApiProperty } from '@nestjs/swagger';
import { DISPUTE_STATUSES, type DisputeStatus } from '../dto/disputes.dto';

/** A dispute's decision, once made. */
export class DisputeDecisionView {
  @ApiProperty({ type: String, format: 'date-time' })
  decidedAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'On a rejection: REASON_CODES.invoiceDisputeReject.',
  })
  reasonCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'On an acceptance: what its credit note took off.',
  })
  creditedAmount: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  creditNoteId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'CN-000031' })
  creditNoteNumber: string | null;
}

/**
 * A dispute as a resident who sees the unit's money reads it (ADR 0048).
 * Its words and photo are the opener's: `null` for everyone else.
 */
export class DisputeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  invoiceId: string;
  @ApiProperty({ type: String, example: 'INV-000123' })
  invoiceNumber: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, description: 'REASON_CODES.invoiceDispute' })
  reasonCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The opener’s words: to the opener only; null once erased.',
  })
  text: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A short-lived link to the opener’s photo: to the opener only.',
  })
  photoUrl: string | null;
  @ApiProperty({ type: Boolean, description: 'The caller opened it.' })
  mine: boolean;
  @ApiProperty({ type: String, enum: DISPUTE_STATUSES })
  status: DisputeStatus;
  @ApiProperty({ type: DisputeDecisionView, nullable: true })
  decision: DisputeDecisionView | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Rejected and not yet taken to the board: until when an owner or the primary may (POST /governance/board-appeals, ADR 0055).',
  })
  boardAppealUntil: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When it was taken to the board.',
  })
  boardAppealAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** A dispute as the staff read it: the words and photo, never a name. */
export class StaffDisputeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  invoiceId: string;
  @ApiProperty({ type: String, example: 'INV-000123' })
  invoiceNumber: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, description: 'REASON_CODES.invoiceDispute' })
  reasonCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The opener’s words; null when none, or once erased.',
  })
  text: string | null;
  @ApiProperty({ type: String, nullable: true })
  photoUrl: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'The opener was erased: their words and photo are gone.',
  })
  cleared: boolean;
  @ApiProperty({
    type: String,
    description: 'What the invoice owes now: the most an acceptance credits.',
  })
  outstanding: string;
  @ApiProperty({ type: String, enum: DISPUTE_STATUSES })
  status: DisputeStatus;
  @ApiProperty({ type: DisputeDecisionView, nullable: true })
  decision: DisputeDecisionView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
