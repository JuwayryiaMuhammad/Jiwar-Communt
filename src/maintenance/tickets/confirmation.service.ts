import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Ticket } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  requireReasonCodeOnly,
  type ReasonInput,
} from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { DispatchEngine } from '../dispatch/dispatch-engine';
import { MaintenanceSettingsService } from '../settings/maintenance-settings.service';
import { MessagesService } from './messages.service';
import { TicketAccess } from './ticket-access';
import { TicketLog } from './ticket-log';
import { TicketNotices } from './ticket-notices';
import { afterRejection, assertCan } from './ticket-rules';

export const AUTO_CLOSE_SWEEP = 'maintenance.auto_close';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Tickets one sweep run closes per compound. */
const SWEEP_BATCH = 500;

/**
 * The end of a ticket (ADR 0032): the reporter confirms (a rating, a
 * comment) or rejects (a reason code and a note); a ticket nobody answers
 * closes itself after `autoCloseHours`; the reporter may reopen within
 * `reopenDays` of closing; the reporter or creator may cancel early, a
 * dispatcher any time before it is closed.
 *
 * A rejection and a reopen take the same path: `cycle + 1` and
 * `rejection_count + 1`. The first goes back to the technician who did the
 * work, any later one back to the queue as an escalation. The note becomes
 * the reporter's message in the thread, where the technician reads it and
 * an erasure finds it.
 */
@Injectable()
export class ConfirmationService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly log: TicketLog,
    private readonly notices: TicketNotices,
    private readonly messages: MessagesService,
    private readonly audit: AuditService,
    private readonly settings: MaintenanceSettingsService,
    private readonly sweep: SweepRunner,
    private readonly engine: DispatchEngine,
  ) {}

  onModuleInit(): void {
    this.sweep.register(AUTO_CLOSE_SWEEP, (now) => this.autoClose(now));
  }

  /** The reporter or creator, before the work starts. */
  cancelByReporter(id: string, reasonCode?: string): Promise<void> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.ticketCancel);
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.resident(tx, id);
      assertCan(ticket, 'cancelByReporter');
      await this.cancel(tx, ticket, code, 'reporter');
    });
  }

  /** A dispatcher, any time before the ticket is closed. */
  cancelByDispatcher(id: string, reasonCode?: string): Promise<void> {
    const code = requireReasonCodeOnly(reasonCode, REASON_CODES.ticketCancel);
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, id, 'dispatch', { lock: true });
      assertCan(ticket, 'cancelByDispatcher');
      await this.cancel(tx, ticket, code, 'dispatcher');
    });
  }

  /**
   * Done well: closed, with the service's rating, an optional comment and
   * an optional rating of the technician who did the work (ADR 0038).
   */
  confirm(
    id: string,
    rating: number,
    comment?: string,
    technicianRating?: number,
  ): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.resident(tx, id);
      assertCan(ticket, 'confirm');
      await tx.ticket.update({
        where: { id },
        data: {
          status: 'closed',
          confirmationStatus: 'confirmed',
          closedAt: new Date(),
        },
      });
      await tx.ticketFeedback.create({
        data: {
          id: newId(),
          tenantId: ticket.tenantId,
          ticketId: id,
          cycle: ticket.cycle,
          kind: 'confirmed',
          authorId: me,
          rating,
          comment: comment?.trim() || null,
          // A completed ticket always has its technician (a CHECK).
          ...(technicianRating !== undefined
            ? { technicianRating, ratedTechnicianId: ticket.technicianId }
            : {}),
        },
      });
      await this.log.status(tx, ticket, {
        from: ticket.status,
        to: 'closed',
        actorId: me,
        cycle: ticket.cycle,
      });
      await this.notices.send(
        tx,
        [ticket.technicianId],
        'ticket.status_changed',
        ticket,
        { status: 'closed' },
        me,
      );
    });
  }

  /** Not fixed: a reason code and a note, and the ticket goes back. */
  async reject(id: string, reason: ReasonInput): Promise<void> {
    const r = requireReasonCode(reason, REASON_CODES.ticketReject);
    const requeued = await this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.resident(tx, id);
      assertCan(ticket, 'reject');
      return this.goBack(tx, ticket, 'rejected', r);
    });
    if (requeued) await this.engine.afterRelease([id]);
  }

  /** The problem came back within the compound's window after closing. */
  async reopen(id: string, reason: ReasonInput): Promise<void> {
    const r = requireReasonCode(reason, REASON_CODES.ticketReopen);
    const requeued = await this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.resident(tx, id);
      assertCan(ticket, 'reopen');
      const { reopenDays } = await this.settings.inTx(tx);
      if (Date.now() > ticket.closedAt!.getTime() + reopenDays * DAY)
        throw appError.conflict(
          ErrorCode.TICKET_REOPEN_WINDOW_PASSED,
          'Too late to reopen; open a new ticket',
          { params: { reopenDays } },
        );
      return this.goBack(tx, ticket, 'reopened', r);
    });
    if (requeued) await this.engine.afterRelease([id]);
  }

  /**
   * Closes completed tickets nobody confirmed within the compound's
   * `autoCloseHours`. Rows are claimed with SKIP LOCKED: a confirmation or
   * a rejection holding the row wins, and the sweep leaves it.
   */
  autoClose(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx, tenantId) => {
      const settings = await tx.maintenanceSettings.findUnique({
        where: { tenantId },
      });
      if (!settings) return 0;
      const cutoff = new Date(now.getTime() - settings.autoCloseHours * HOUR);
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM tickets
         WHERE status = 'completed' AND completed_at <= ${cutoff}
         ORDER BY completed_at, id
         LIMIT ${SWEEP_BATCH}
           FOR UPDATE SKIP LOCKED`;
      for (const { id } of due) {
        const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
        await tx.ticket.update({
          where: { id },
          data: {
            status: 'closed',
            confirmationStatus: 'auto_closed',
            closedAt: now,
          },
        });
        await this.log.status(tx, ticket, {
          from: 'completed',
          to: 'closed',
          actorId: null,
          cycle: ticket.cycle,
        });
        await this.notices.send(
          tx,
          [ticket.reporterId],
          'ticket.auto_closed',
          ticket,
        );
      }
      return due.length;
    });
  }

  /**
   * The resident's own ticket, locked: their account row first (a comment
   * or a note never lands after their erasure), then the ticket. Only its
   * reporter or creator, and only while they may still open tickets there.
   */
  private async resident(tx: TenantTxClient, id: string): Promise<Ticket> {
    await this.access.lockSelf(tx);
    const ticket = await this.access.load(tx, id, 'resident', {
      lock: true,
    });
    this.access.requireParty(ticket);
    await this.access.requireTickets(tx, ticket);
    return ticket;
  }

  private async cancel(
    tx: TenantTxClient,
    ticket: Ticket,
    reasonCode: string,
    by: 'reporter' | 'dispatcher',
  ): Promise<void> {
    const me = this.ctx.accountId;
    await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        holdReason: null,
        // A cancelled completion is no longer waiting for anyone.
        confirmationStatus:
          ticket.confirmationStatus === 'pending'
            ? null
            : ticket.confirmationStatus,
      },
    });
    await this.log.status(tx, ticket, {
      from: ticket.status,
      to: 'cancelled',
      actorId: me,
      reasonCode,
      cycle: ticket.cycle,
    });
    await this.audit.record(tx, {
      action: 'ticket.cancelled',
      targetId: ticket.id,
      metadata: { reasonCode, by, fromStatus: ticket.status },
    });
    await this.notices.send(
      tx,
      [ticket.technicianId, ticket.reporterId],
      'ticket.status_changed',
      ticket,
      { status: 'cancelled' },
      me,
    );
  }

  /**
   * Returns whether the ticket went back to the queue **without** being an
   * escalation (its technician cannot take it back): the dispatch engine
   * may then give it to someone else, after commit (ADR 0033). An
   * escalation (a second rejection or reopen) goes to the dispatchers on
   * purpose and is never the engine's.
   */
  private async goBack(
    tx: TenantTxClient,
    ticket: Ticket,
    kind: 'rejected' | 'reopened',
    reason: { code: string; text: string },
  ): Promise<boolean> {
    const me = this.ctx.accountId;
    const next = afterRejection({
      rejectionCount: ticket.rejectionCount,
      technicianId: ticket.technicianId,
      technicianAvailable:
        !!ticket.technicianId &&
        (await this.access.isTechnician(tx, ticket.technicianId)),
    });
    const cycle = ticket.cycle + 1;
    const rejectionCount = ticket.rejectionCount + 1;
    await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        status: next.status,
        technicianId: next.technicianId,
        assignedAt: next.technicianId ? new Date() : null,
        confirmationStatus: 'rejected',
        closedAt: null,
        cycle,
        rejectionCount,
      },
    });
    await tx.ticketFeedback.create({
      data: {
        id: newId(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        cycle: ticket.cycle,
        kind,
        authorId: me,
        reasonCode: reason.code,
      },
    });
    await this.messages.write(tx, ticket, me, reason.text, false);
    await this.log.status(tx, ticket, {
      from: ticket.status,
      to: next.status,
      actorId: me,
      reasonCode: reason.code,
      cycle,
    });
    if (next.status === 'new' && ticket.technicianId)
      await this.log.assignment(tx, ticket, {
        type: 'released',
        fromId: ticket.technicianId,
        toId: null,
        assignedById: null,
        reasonCode: next.escalated ? 'escalated' : 'technician_unavailable',
        cycle,
      });
    const extra = { rejectionCount };
    const dispatchers = await this.notices.dispatchers(tx);
    if (next.escalated)
      await this.notices.send(
        tx,
        dispatchers,
        'ticket.escalated',
        ticket,
        extra,
      );
    else
      await this.notices.send(
        tx,
        [...dispatchers, next.technicianId],
        kind === 'rejected' ? 'ticket.rejected' : 'ticket.reopened',
        ticket,
        extra,
        me,
      );
    return next.status === 'new' && !next.escalated;
  }
}
