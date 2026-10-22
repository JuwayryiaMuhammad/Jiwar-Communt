import type { TicketStatus } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/** A positive EGP amount below ten million, two decimals at most. */
export const QUOTE_AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,7}(\.\d{1,2})?$/;
export const QUOTE_NOTE_MAX = 1000;

export const QUOTE_STATUSES = [
  'proposed',
  'approved',
  'declined',
  'withdrawn',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** A quote is stated before the work starts (ADR 0058). */
export const QUOTABLE: readonly TicketStatus[] = [
  'new',
  'assigned',
  'en_route',
];

/**
 * Whether the work may start, by the ticket's quotes (ADR 0058): not while
 * one waits, nor when the last one decided was declined. A withdrawn quote
 * counts as none. The caller holds the ticket's lock, which every quote
 * write takes first, so the answer holds until it commits.
 */
export async function assertQuoteAllowsStart(
  tx: TenantTxClient,
  ticketId: string,
): Promise<void> {
  const last = await tx.ticketQuote.findFirst({
    where: { ticketId, status: { not: 'withdrawn' } },
    orderBy: [{ proposedAt: 'desc' }, { id: 'desc' }],
    select: { status: true },
  });
  if (last && last.status !== 'approved')
    throw appError.conflict(
      ErrorCode.TICKET_QUOTE_NOT_APPROVED,
      'The work waits for the quote’s approval',
      { params: { status: last.status } },
    );
}
