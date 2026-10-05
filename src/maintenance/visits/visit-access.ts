import { Injectable } from '@nestjs/common';
import type { Ticket, TicketVisit, VisitSide } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  ticketNotFound,
  TicketAccess,
  type Audience,
} from '../tickets/ticket-access';
import { assertCan } from '../tickets/ticket-rules';

export const visitNotFound = () =>
  appError.notFound(ErrorCode.VISIT_NOT_FOUND, 'Visit not found');

/** The side an audience acts on: dispatch acts for the technician. */
export function sideOf(audience: Audience): Exclude<VisitSide, 'system'> {
  return audience === 'resident' ? 'resident' : 'technician';
}

/**
 * Who reaches a ticket's visits (ADR 0034), and how they are locked.
 *
 * - **Residents:** those who see the ticket (ADR 0032) and may still act on
 *   it (`tickets` on its unit now), **or** any adult who lives in the unit
 *   (`visitConsent`, active account) — without seeing the ticket itself.
 * - **The technician:** the ticket's technician now, and only their own
 *   visits.
 * - **Dispatch:** every visit.
 *
 * Lock order: the resident's own account row (`FOR SHARE`: a deactivation,
 * a freeze or an erasure updates it first, so it is ordered before or after
 * the write), then the ticket (`FOR UPDATE`); every visit write takes the
 * ticket's lock before it reads the visit, so writes on one ticket's visits
 * never interleave.
 */
@Injectable()
export class VisitAccess {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tickets: TicketAccess,
    private readonly community: CommunityMaintenancePort,
  ) {}

  /** The ticket, for a write: locked, the rules checked, a unit's only. */
  async forWrite(
    tx: TenantTxClient,
    ticketId: string,
    audience: Audience,
  ): Promise<Ticket> {
    let ticket: Ticket;
    if (audience === 'resident') {
      await this.tickets.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticketId}::uuid FOR UPDATE`;
      ticket = await this.resident(tx, ticketId, true);
    } else
      ticket = await this.tickets.load(tx, ticketId, audience, { lock: true });
    if (ticket.unitId === null)
      throw appError.conflict(
        ErrorCode.VISIT_NOT_FOR_COMMON_AREA,
        'A common-area ticket has no visits',
      );
    assertCan(ticket, 'visit');
    return ticket;
  }

  /** The ticket, for a read. */
  async forRead(
    tx: TenantTxClient,
    ticketId: string,
    audience: Audience,
  ): Promise<Ticket> {
    return audience === 'resident'
      ? this.resident(tx, ticketId, false)
      : this.tickets.load(tx, ticketId, audience);
  }

  /**
   * One of the ticket's visits as `audience` may reach it: the technician
   * only their own. VISIT_NOT_FOUND otherwise.
   */
  async visit(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id'>,
    visitId: string,
    audience: Audience,
  ): Promise<TicketVisit> {
    const visit = await tx.ticketVisit.findFirst({
      where: { id: visitId, ticketId: ticket.id },
    });
    if (
      !visit ||
      (audience === 'technician' && visit.technicianId !== this.ctx.accountId)
    )
      throw visitNotFound();
    return visit;
  }

  /**
   * A resident's way to a ticket's visits: they see it (and, to write, may
   * still act on it), or they live in its unit. TICKET_NOT_FOUND for anyone
   * else; TICKETS_NOT_ALLOWED for one who sees it but may no longer act.
   */
  private async resident(
    tx: TenantTxClient,
    ticketId: string,
    write: boolean,
  ): Promise<Ticket> {
    const me = this.ctx.accountId;
    const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw ticketNotFound();
    if (
      ticket.unitId !== null &&
      (await this.community.mayConsent(tx, me, ticket.unitId))
    )
      return ticket;
    if (!(await this.tickets.sees(tx, ticket, 'resident')))
      throw ticketNotFound();
    if (write) await this.tickets.requireTickets(tx, ticket);
    return ticket;
  }
}
