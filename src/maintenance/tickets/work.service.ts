import { Injectable } from '@nestjs/common';
import type { Ticket, TicketHoldReason, TicketStatus } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { DispatchEngine } from '../dispatch/dispatch-engine';
import { TicketAccess } from './ticket-access';
import { TicketLog } from './ticket-log';
import { TicketNotices } from './ticket-notices';
import { assertCan, type TicketAction } from './ticket-rules';

/**
 * The technician's workflow (ADR 0032), on their own tickets only:
 * start, hold with a reason, resume, complete (the reporter is asked to
 * confirm), and decline before starting (back to the queue). Each action
 * locks the ticket and checks the rules after the lock.
 */
@Injectable()
export class WorkService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly log: TicketLog,
    private readonly notices: TicketNotices,
    private readonly engine: DispatchEngine,
  ) {}

  start(id: string): Promise<void> {
    return this.move(id, 'start', 'in_progress');
  }

  /** The hold reason is what the SLA pauses on (Phase 5.3). */
  hold(id: string, holdReason: TicketHoldReason): Promise<void> {
    return this.move(id, 'hold', 'on_hold', holdReason);
  }

  resume(id: string): Promise<void> {
    return this.move(id, 'resume', 'in_progress');
  }

  /** Done: the reporter is asked to confirm, or the sweep closes it. */
  complete(id: string): Promise<void> {
    return this.move(id, 'complete', 'completed');
  }

  /**
   * Not for me, with a reason: back to the queue, and every dispatcher is
   * told. The technician loses the ticket at once; the dispatch engine
   * (ADR 0033) tries the next candidate and never offers it to them again.
   */
  async decline(id: string, reasonCode?: string): Promise<void> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.ticketDecline);
    const me = this.ctx.accountId;
    await this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.lock(tx, id, 'decline');
      await tx.ticket.update({
        where: { id },
        data: { status: 'new', technicianId: null, assignedAt: null },
      });
      await this.log.assignment(tx, ticket, {
        type: 'declined',
        fromId: me,
        toId: null,
        assignedById: me,
        reasonCode: code,
        cycle: ticket.cycle,
      });
      await this.log.status(tx, ticket, {
        from: ticket.status,
        to: 'new',
        actorId: me,
        reasonCode: code,
        cycle: ticket.cycle,
      });
      await this.notices.send(
        tx,
        await this.notices.dispatchers(tx),
        'ticket.declined',
        ticket,
        {},
        me,
      );
    });
    // After the decline committed, in a transaction of its own: the
    // `declined` row is what keeps the engine from offering the ticket back
    // to the technician who just refused it (ADR 0033).
    await this.engine.dispatch([id], 'declined');
  }

  private move(
    id: string,
    action: TicketAction,
    to: TicketStatus,
    holdReason: TicketHoldReason | null = null,
  ): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.lock(tx, id, action);
      await this.moveInTx(tx, ticket, to, holdReason);
    });
  }

  /**
   * The technician's move of a locked ticket whose rules the caller checked
   * (`assertCan`): the row, its history row and the reporter's notice. A
   * visit's arrival starts the work and a visit with no access puts it on
   * hold through here (ADR 0034), so both read exactly as the technician's
   * own start and hold.
   */
  async moveInTx(
    tx: TenantTxClient,
    ticket: Ticket,
    to: TicketStatus,
    holdReason: TicketHoldReason | null = null,
  ): Promise<void> {
    const me = this.ctx.accountId;
    const now = new Date();
    await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        status: to,
        holdReason,
        ...(to === 'completed'
          ? { confirmationStatus: 'pending', completedAt: now }
          : {}),
      },
    });
    await this.log.status(tx, ticket, {
      from: ticket.status,
      to,
      actorId: me,
      reasonCode: holdReason,
      cycle: ticket.cycle,
    });
    if (to === 'completed')
      await this.notices.send(
        tx,
        [ticket.reporterId],
        'ticket.completed',
        ticket,
      );
    else
      await this.notices.send(
        tx,
        [ticket.reporterId],
        'ticket.status_changed',
        ticket,
        holdReason ? { status: to, holdReason } : { status: to },
      );
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
    action: TicketAction,
  ): Promise<Ticket> {
    const ticket = await this.access.load(tx, id, 'technician', {
      lock: true,
    });
    assertCan(ticket, action);
    return ticket;
  }
}
