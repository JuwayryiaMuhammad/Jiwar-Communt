import { ApiProperty } from '@nestjs/swagger';
import type { TicketQuoteSuggestion } from '@prisma/client';
import { QUOTE_STATUSES, type QuoteStatus } from '../quote-rules';
import type { QuoteRead } from '../quotes.service';

/** A ticket's quote as its residents read it (ADR 0058): no one's id. */
export class ResidentQuoteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: '350.00', description: 'EGP.' })
  amount: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ enum: QUOTE_STATUSES, enumName: 'TicketQuoteStatus' })
  status: QuoteStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  proposedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'Decided by the caller (null while undecided).',
  })
  decidedByMe: boolean | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.ticketQuoteDecline.',
  })
  declineReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt: Date | null;
  @ApiProperty({
    type: Boolean,
    description: 'The caller may approve or decline it now.',
  })
  mayDecide: boolean;

  static from(r: QuoteRead, me: string): ResidentQuoteView {
    const q = r.quote;
    return {
      id: q.id,
      amount: q.amount.toFixed(2),
      note: q.note,
      status: q.status as QuoteStatus,
      proposedAt: q.proposedAt,
      decidedAt: q.decidedAt,
      decidedByMe: q.decidedById ? q.decidedById === me : null,
      declineReason: q.declineReason,
      withdrawnAt: q.withdrawnAt,
      mayDecide: r.mayDecide,
    };
  }
}

/** A ticket's quote for the dispatch: who proposed, decided or withdrew. */
export class DispatchQuoteView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: '350.00', description: 'EGP.' })
  amount: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ enum: QUOTE_STATUSES, enumName: 'TicketQuoteStatus' })
  status: QuoteStatus;
  @ApiProperty({ type: String, format: 'uuid' })
  proposedById: string;
  @ApiProperty({ type: String, format: 'date-time' })
  proposedAt: Date;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  decidedById: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  declineReason: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  withdrawnById: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt: Date | null;

  static from(r: QuoteRead): DispatchQuoteView {
    const q = r.quote;
    return {
      id: q.id,
      amount: q.amount.toFixed(2),
      note: q.note,
      status: q.status as QuoteStatus,
      proposedById: q.proposedById,
      proposedAt: q.proposedAt,
      decidedById: q.decidedById,
      decidedAt: q.decidedAt,
      declineReason: q.declineReason,
      withdrawnById: q.withdrawnById,
      withdrawnAt: q.withdrawnAt,
    };
  }
}

export class QuoteCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
}

/** A price the technician suggested (ADR 0065): staff only. */
export class QuoteSuggestionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  ticketId: string;
  @ApiProperty({ type: String, description: 'EGP.' })
  amount: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ enum: ['pending', 'sent', 'dismissed'] })
  status: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  suggestedById: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  suggestedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.quoteSuggestionDismiss.',
  })
  dismissReason: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The quote it was sent as.',
  })
  quoteId: string | null;

  static from(s: TicketQuoteSuggestion): QuoteSuggestionView {
    return {
      id: s.id,
      ticketId: s.ticketId,
      amount: s.amount.toFixed(2),
      note: s.note,
      status: s.status,
      suggestedById: s.suggestedById,
      suggestedAt: s.suggestedAt,
      decidedAt: s.decidedAt,
      dismissReason: s.dismissReason,
      quoteId: s.quoteId,
    };
  }
}
