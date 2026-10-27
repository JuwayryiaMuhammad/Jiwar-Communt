import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Ticket, TicketQuote } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
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
import { TicketAccess, type Audience } from '../tickets/ticket-access';
import { TicketNotices } from '../tickets/ticket-notices';
import { QUOTABLE, type QuoteStatus } from './quote-rules';

export const QUOTE_RESOURCE = 'ticket_quote';
export const QUOTE_DECISION_RESOURCE = 'ticket_quote_decision';

export interface QuoteRead {
  quote: TicketQuote;
  /** The caller may approve or decline it now (residents). */
  mayDecide: boolean;
}

const quoteNotFound = () =>
  appError.notFound(ErrorCode.TICKET_QUOTE_NOT_FOUND, 'Quote not found');

/**
 * A quote on a ticket (ADR 0058). The dispatch states what the work will
 * cost before it starts; the reporter or the unit's primary approves or
 * declines it; the dispatch may withdraw one that waits. The work does not
 * start while a quote waits or the last one was declined
 * (`assertQuoteAllowsStart`, checked by the technician's start and a
 * visit's arrival).
 *
 * Every write locks the caller's account (shared), then the ticket
 * (`FOR UPDATE`), and decides by what it reads after the lock: a decision
 * racing a withdrawal, or a start racing a decline, sees the winner.
 * Times are the database's.
 */
@Injectable()
export class QuotesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly notices: TicketNotices,
    private readonly community: CommunityMaintenancePort,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(QUOTE_RESOURCE, (id) => Promise.resolve({ id }));
    // A decision answers 204: a replay renders nothing.
    this.idempotency.renderer(QUOTE_DECISION_RESOURCE, () =>
      Promise.resolve(undefined),
    );
  }

  /** Dispatch: a quote for the residents to decide. */
  propose(
    ticketId: string,
    input: { amount: string; note?: string },
  ): Promise<{ id: string }> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: QUOTE_RESOURCE, id });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'dispatch', {
        lock: true,
      });
      // The compound's own work orders are its cost, never a household's
      // to approve (ADR 0064).
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
      if (
        await tx.ticketQuote.count({ where: { ticketId, status: 'proposed' } })
      )
        throw appError.conflict(
          ErrorCode.TICKET_QUOTE_EXISTS,
          'A quote of this ticket already waits',
        );
      const quote = await tx.ticketQuote.create({
        data: {
          id,
          tenantId: ticket.tenantId,
          ticketId,
          amount: input.amount,
          note: input.note ?? null,
          proposedById: me,
        },
      });
      await this.audit.record(tx, {
        action: 'ticket_quote.proposed',
        targetId: id,
        changes: diffChanges(
          null,
          {
            ticketId,
            amount: quote.amount.toFixed(2),
            note: quote.note,
          },
          'ticket_quote.proposed',
        ),
      });
      await this.notices.send(
        tx,
        await this.deciders(tx, ticket),
        'ticket.quote_proposed',
        ticket,
        { amount: quote.amount.toFixed(2) },
        me,
      );
      return { id };
    });
  }

  /** Dispatch: takes back a quote that waits. */
  withdraw(ticketId: string, quoteId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'dispatch', {
        lock: true,
      });
      const quote = await this.waiting(tx, ticketId, quoteId);
      await tx.$executeRaw`
        UPDATE ticket_quotes
           SET status = 'withdrawn', withdrawn_by_account_id = ${me}::uuid,
               withdrawn_at = now()
         WHERE id = ${quote.id}::uuid`;
      await this.audit.record(tx, {
        action: 'ticket_quote.withdrawn',
        targetId: quote.id,
        metadata: { ticketId },
      });
      await this.notices.send(
        tx,
        await this.deciders(tx, ticket),
        'ticket.quote_withdrawn',
        ticket,
        {},
        me,
      );
    });
  }

  /**
   * The reporter or the unit's primary approves or declines (with a code
   * from `ticketQuoteDecline`), while they may still open tickets there.
   */
  decide(
    ticketId: string,
    quoteId: string,
    decision: 'approve' | 'decline',
    reasonCode?: string,
  ): Promise<void> {
    const me = this.ctx.accountId;
    const reason =
      decision === 'decline'
        ? requireReasonCodeOnly(reasonCode, REASON_CODES.ticketQuoteDecline)
        : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.idempotency.claim(tx, {
        type: QUOTE_DECISION_RESOURCE,
        id: quoteId,
      });
      await this.access.lockSelf(tx);
      const ticket = await this.access.load(tx, ticketId, 'resident', {
        lock: true,
      });
      const quote = await this.waiting(tx, ticketId, quoteId);
      if (!(await this.mayDecide(tx, ticket)))
        throw appError.forbidden(
          ErrorCode.TICKET_ACTION_NOT_ALLOWED,
          'Only the reporter or the unit’s primary decides a quote',
        );
      await this.access.requireTickets(tx, ticket);
      const status: QuoteStatus = reason ? 'declined' : 'approved';
      await tx.$executeRaw`
        UPDATE ticket_quotes
           SET status = ${status}, decided_by_account_id = ${me}::uuid,
               decided_at = now(), decline_reason = ${reason}
         WHERE id = ${quote.id}::uuid`;
      await this.audit.record(tx, {
        action: reason ? 'ticket_quote.declined' : 'ticket_quote.approved',
        targetId: quote.id,
        metadata: reason ? { ticketId, reasonCode: reason } : { ticketId },
      });
      await this.notices.send(
        tx,
        [...(await this.notices.dispatchers(tx)), ticket.technicianId],
        reason ? 'ticket.quote_declined' : 'ticket.quote_approved',
        ticket,
        reason ? { reason } : {},
        me,
      );
    });
  }

  /** A ticket's quotes, oldest first, for whoever sees the ticket. */
  list(ticketId: string, audience: Audience): Promise<QuoteRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, ticketId, audience);
      const quotes = await tx.ticketQuote.findMany({
        where: { ticketId },
        orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }],
      });
      const may =
        audience === 'resident' && quotes.some((q) => q.status === 'proposed')
          ? (await this.mayDecide(tx, ticket)) &&
            (await this.access.mayOpen(tx, ticket.unitId, this.ctx.accountId))
          : false;
      return quotes.map((quote) => ({
        quote,
        mayDecide: may && quote.status === 'proposed',
      }));
    });
  }

  /** The quote, still waiting, of this ticket. */
  private async waiting(
    tx: TenantTxClient,
    ticketId: string,
    quoteId: string,
  ): Promise<TicketQuote> {
    const quote = await tx.ticketQuote.findFirst({
      where: { id: quoteId, ticketId },
    });
    if (!quote) throw quoteNotFound();
    if (quote.status !== 'proposed')
      throw appError.conflict(
        ErrorCode.TICKET_QUOTE_INVALID_TRANSITION,
        `A ${quote.status} quote cannot change`,
        { params: { status: quote.status } },
      );
    return quote;
  }

  /** The reporter, or the unit's primary now. */
  private async mayDecide(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'reporterId' | 'unitId'>,
  ): Promise<boolean> {
    const me = this.ctx.accountId;
    if (ticket.reporterId === me) return true;
    return (
      ticket.unitId !== null &&
      (await this.community.primaryOf(tx, ticket.unitId)) === me
    );
  }

  private async deciders(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'reporterId' | 'unitId'>,
  ): Promise<(string | null)[]> {
    return [
      ticket.reporterId,
      ticket.unitId ? await this.community.primaryOf(tx, ticket.unitId) : null,
    ];
  }
}
