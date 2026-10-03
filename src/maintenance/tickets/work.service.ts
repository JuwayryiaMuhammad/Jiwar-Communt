import { Injectable } from '@nestjs/common';
import type { Ticket, TicketHoldReason, TicketStatus } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
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
   * (Phase 5.2) will not offer it to them again (the `declined` row).
   */
  decline(id: string, reasonCode?: string): Promise<void> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.ticketDecline);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
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
  }

  private move(
    id: string,
    action: TicketAction,
    to: TicketStatus,
    holdReason: TicketHoldReason | null = null,
  ): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.lock(tx, id, action);
      const now = new Date();
      await tx.ticket.update({
        where: { id },
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
    });
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
