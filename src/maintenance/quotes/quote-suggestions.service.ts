import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Ticket, TicketQuoteSuggestion } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { TicketAccess, type Audience } from '../tickets/ticket-access';
import { TicketNotices } from '../tickets/ticket-notices';
import { QUOTABLE } from './quote-rules';
import { QuotesService } from './quotes.service';

export const QUOTE_SUGGESTION_RESOURCE = 'ticket_quote_suggestion';
/** A ticket's suggestions listed at most, newest first. */
export const QUOTE_SUGGESTIONS_SHOWN = 50;

export interface SuggestionInput {
  amount: string;
  note?: string;
}

const suggestionNotFound = () =>
  appError.notFound(
    ErrorCode.QUOTE_SUGGESTION_NOT_FOUND,
    'Suggested quote not found',
  );

/**
 * A price the technician found on site (ADR 0065). They suggest it on a
 * resident's unit ticket before the work starts — exactly where dispatch
 * may quote (ADR 0058) — and dispatch sends it as the ticket's quote, as
 * it is or amended, or dismisses it with a reason. One waits per ticket
 * (a partial unique index backs the check), and it is decided once.
 * Residents never see a suggestion: only the quote dispatch sends.
 *
 * Lock order: the caller's account (shared), then the ticket (`FOR
 * UPDATE`), then the suggestion; sending proposes the quote under the same
 * ticket lock, so a send racing a dismissal, or the work starting, sees
 * the winner. Times are the database's.
 */
@Injectable()
export class QuoteSuggestionsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly notices: TicketNotices,
    private readonly quotes: QuotesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(QUOTE_SUGGESTION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const s = await tx.ticketQuoteSuggestion.findUnique({ where: { id } });
        if (!s) throw suggestionNotFound();
        return s;
      }),
    );
  }

  /** A ticket's suggestions, newest first: its technician's or dispatch's. */
  list(
    ticketId: string,
    audience: Extract<Audience, 'technician' | 'dispatch'>,
  ): Promise<TicketQuoteSuggestion[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, ticketId, audience);
      return tx.ticketQuoteSuggestion.findMany({
        where: { ticketId },
        orderBy: [{ suggestedAt: 'desc' }, { id: 'desc' }],
        take: QUOTE_SUGGESTIONS_SHOWN,
      });
    });
  }

  /** The ticket's technician: a price for dispatch to send. */
  suggest(
    ticketId: string,
    input: SuggestionInput,
  ): Promise<TicketQuoteSuggestion> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: QUOTE_SUGGESTION_RESOURCE,
        id,
      });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'technician', {
        lock: true,
      });
      requireQuotable(ticket);
      if (
        await tx.ticketQuoteSuggestion.count({
          where: { ticketId, status: 'pending' },
        })
      )
        throw appError.conflict(
          ErrorCode.QUOTE_SUGGESTION_EXISTS,
          'A suggested quote already waits on this ticket',
        );
      const suggestion = await tx.ticketQuoteSuggestion.create({
        data: {
          id,
          tenantId: ticket.tenantId,
          ticketId,
          amount: input.amount,
          note: input.note?.trim() || null,
          suggestedById: me,
          suggestedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'quote_suggestion.made',
        targetId: id,
        changes: diffChanges(
          null,
          {
            ticketId,
            amount: suggestion.amount.toFixed(2),
            note: suggestion.note,
          },
          'quote_suggestion.made',
        ),
      });
      await this.notices.send(
        tx,
        await this.notices.dispatchers(tx),
        'ticket.quote_suggested',
        ticket,
        { amount: suggestion.amount.toFixed(2) },
        me,
      );
      return suggestion;
    });
  }

  /**
   * Dispatch: sends the suggestion as the ticket's quote, its amount and
   * note unless amended; the residents are asked as for any quote.
   */
  send(
    suggestionId: string,
    amend: Partial<SuggestionInput> = {},
  ): Promise<TicketQuoteSuggestion> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { ticket, suggestion } = await this.lockPending(tx, suggestionId);
      const quote = await this.quotes.proposeLocked(tx, ticket, newId(), {
        amount: amend.amount ?? suggestion.amount.toFixed(2),
        note: amend.note ?? suggestion.note ?? undefined,
      });
      const sent = await tx.ticketQuoteSuggestion.update({
        where: { id: suggestionId },
        data: {
          status: 'sent',
          decidedById: me,
          decidedAt: await dbNow(tx),
          quoteId: quote.id,
        },
      });
      await this.audit.record(tx, {
        action: 'quote_suggestion.sent',
        targetId: suggestionId,
        metadata: {
          ticketId: ticket.id,
          quoteId: quote.id,
          amended: amend.amount !== undefined || amend.note !== undefined,
        },
      });
      return sent;
    });
  }

  /** Dispatch: not sent, with a reason; the technician is told which. */
  dismiss(
    suggestionId: string,
    reasonCode?: string,
  ): Promise<TicketQuoteSuggestion> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.quoteSuggestionDismiss,
    );
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { ticket, suggestion } = await this.lockPending(tx, suggestionId);
      const dismissed = await tx.ticketQuoteSuggestion.update({
        where: { id: suggestionId },
        data: {
          status: 'dismissed',
          decidedById: me,
          decidedAt: await dbNow(tx),
          dismissReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'quote_suggestion.dismissed',
        targetId: suggestionId,
        metadata: { ticketId: ticket.id, reasonCode: reason },
      });
      await this.notices.send(
        tx,
        [suggestion.suggestedById],
        'ticket.quote_suggestion_dismissed',
        ticket,
        { reason },
        me,
      );
      return dismissed;
    });
  }

  /** Account, ticket, then the suggestion; pending after the locks. */
  private async lockPending(
    tx: TenantTxClient,
    suggestionId: string,
  ): Promise<{ ticket: Ticket; suggestion: TicketQuoteSuggestion }> {
    await this.access.lockSelf(tx);
    const seen = await tx.ticketQuoteSuggestion.findUnique({
      where: { id: suggestionId },
      select: { ticketId: true },
    });
    if (!seen) throw suggestionNotFound();
    const ticket = await this.access.load(tx, seen.ticketId, 'dispatch', {
      lock: true,
    });
    await tx.$queryRaw`SELECT id FROM ticket_quote_suggestions WHERE id = ${suggestionId}::uuid FOR UPDATE`;
    const suggestion = await tx.ticketQuoteSuggestion.findUniqueOrThrow({
      where: { id: suggestionId },
    });
    if (suggestion.status !== 'pending')
      throw appError.conflict(
        ErrorCode.QUOTE_SUGGESTION_DECIDED,
        'This suggested quote is decided',
        { params: { status: suggestion.status } },
      );
    return { ticket, suggestion };
  }
}

/** Where dispatch may quote (ADR 0058), the technician may suggest. */
function requireQuotable(ticket: Ticket): void {
  if (
    ticket.origin !== 'resident' ||
    ticket.unitId === null ||
    !QUOTABLE.includes(ticket.status)
  )
    throw appError.conflict(
      ErrorCode.TICKET_QUOTE_NOT_ALLOWED,
      'A quote is for a resident’s unit ticket before its work starts',
      { params: { status: ticket.status } },
    );
}
