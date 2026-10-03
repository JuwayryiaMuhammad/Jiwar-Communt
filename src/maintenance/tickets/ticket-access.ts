import { Injectable } from '@nestjs/common';
import type { Ticket } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Who reads a ticket, and so which view and which rules apply (ADR 0032).
 * Each audience has its own routes: a resident (`tickets.create`), the
 * technician (`tickets.work`) and dispatch (`tickets.dispatch`).
 */
export type Audience = 'resident' | 'technician' | 'dispatch';

export const ticketNotFound = () =>
  appError.notFound(ErrorCode.TICKET_NOT_FOUND, 'Ticket not found');

/**
 * Loads a ticket for an audience, or TICKET_NOT_FOUND: one answer for an
 * unknown id, another compound's ticket (RLS) and one the caller may not
 * see.
 *
 * - a resident sees the tickets they created or reported, and every ticket
 *   of a unit they are the primary of now;
 * - a technician sees only the tickets assigned to them now: a reassigned
 *   or declining technician loses them at once;
 * - dispatch sees every ticket of the compound.
 *
 * Writes lock the row first (`FOR UPDATE`) and check after the lock, so a
 * request that lost a race sees the winner's commit. Locks are always
 * taken account row first, then the ticket.
 */
@Injectable()
export class TicketAccess {
  constructor(
    private readonly ctx: RequestContext,
    private readonly community: CommunityMaintenancePort,
  ) {}

  async load(
    tx: TenantTxClient,
    id: string,
    audience: Audience,
    opts: { lock?: boolean } = {},
  ): Promise<Ticket> {
    if (opts.lock)
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id}::uuid FOR UPDATE`;
    const ticket = await tx.ticket.findUnique({ where: { id } });
    if (!ticket || !(await this.sees(tx, ticket, audience)))
      throw ticketNotFound();
    return ticket;
  }

  async sees(
    tx: TenantTxClient,
    ticket: Pick<
      Ticket,
      'createdById' | 'reporterId' | 'unitId' | 'technicianId'
    >,
    audience: Audience,
  ): Promise<boolean> {
    const me = this.ctx.accountId;
    switch (audience) {
      case 'dispatch':
        return true;
      case 'technician':
        return ticket.technicianId === me;
      case 'resident':
        if (ticket.createdById === me || ticket.reporterId === me) return true;
        return (
          ticket.unitId !== null &&
          (await this.community.primaryOf(tx, ticket.unitId)) === me
        );
    }
  }

  /**
   * The caller's own account row, shared-locked for the rest of the
   * transaction: an erasure (which locks it first) either finished before,
   * and the caller is refused, or waits until this write has committed and
   * then nulls it with the rest (ADR 0023, 0032).
   */
  async lockSelf(tx: TenantTxClient): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${this.ctx.accountId}::uuid FOR SHARE`;
    if (rows[0]?.status !== 'active')
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }

  /**
   * A resident acts on a ticket only while they may still open tickets
   * there: `tickets` on its unit, or on any unit for a common area. Reading
   * does not need it.
   */
  async requireTickets(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'unitId'>,
    accountId = this.ctx.accountId,
  ): Promise<void> {
    if (!(await this.mayOpen(tx, ticket.unitId, accountId)))
      throw appError.forbidden(
        ErrorCode.TICKETS_NOT_ALLOWED,
        'Tickets are not allowed here',
      );
  }

  /** `tickets` on the unit, or on any unit for a common area (null). */
  async mayOpen(
    tx: TenantTxClient,
    unitId: string | null,
    accountId: string,
  ): Promise<boolean> {
    if (unitId === null)
      return (await this.community.ticketUnits(tx, accountId)).length > 0;
    const place = await this.community.placeIn(tx, accountId, unitId);
    return place?.tickets === true;
  }

  /** The reporter's and the creator's own actions (confirm, cancel…). */
  requireParty(ticket: Pick<Ticket, 'createdById' | 'reporterId'>): void {
    const me = this.ctx.accountId;
    if (ticket.reporterId !== me && ticket.createdById !== me)
      throw appError.forbidden(
        ErrorCode.TICKET_ACTION_NOT_ALLOWED,
        'Only the reporter or the creator may do this',
      );
  }
}
