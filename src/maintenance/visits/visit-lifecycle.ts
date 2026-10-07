import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Ticket } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { TicketAccess } from '../tickets/ticket-access';
import { TicketLog } from '../tickets/ticket-log';
import { TicketNotices } from '../tickets/ticket-notices';
import { VisitLog } from './visit-log';
import { can } from '../tickets/ticket-rules';
import { LATE_AFTER_MS, MIN_LEAD_MS } from './visit-rules';
import { VisitsService } from './visits.service';

export const VISIT_LATE_SWEEP = 'maintenance.visit_late';
/** A visit is late at a minute, not at an hour. */
export const VISIT_LATE_INTERVAL_MS = 60_000;
/** Late visits one run notices per compound. */
const LATE_BATCH = 500;

type SystemReason =
  | 'technician_changed'
  | 'ticket_cancelled'
  | 'ticket_closed'
  | 'ticket_completed';

/**
 * What happens to a ticket's visit when the ticket changes without anyone
 * touching the visit (ADR 0034), in the change's own transaction and under
 * its ticket lock — through TicketLog, which every path passes (a request,
 * the dispatch engine, a lifecycle release, a role change, a sweep), so
 * core never imports maintenance and no path is forgotten:
 *
 * - the technician changes or is released (a decline, a reassignment, a
 *   deactivation, freeze or erasure, a lost permission): the active visit is
 *   cancelled, its consent void, and the residents are told;
 * - the ticket is cancelled or closed: the same;
 * - the work is reported done: an arrived visit is done, a proposed or
 *   confirmed one cancelled (it would only block the next);
 * - a technician takes a preventive ticket (ADR 0038): the window its
 *   request asked for is proposed to them, while the request still stands.
 *
 * And the late sweep: a confirmed visit not arrived 15 minutes after its
 * start, noticed once per visit, to the residents and the dispatchers.
 */
@Injectable()
export class VisitLifecycle implements OnModuleInit {
  constructor(
    private readonly log: TicketLog,
    private readonly visits: VisitsService,
    private readonly visitLog: VisitLog,
    private readonly notices: TicketNotices,
    private readonly sweep: SweepRunner,
    private readonly access: TicketAccess,
  ) {}

  onModuleInit(): void {
    // One handler, in this order: the old technician's visit ends, then
    // the new one is offered what a preventive request asked for. Two
    // handlers would depend on the order modules register them in.
    this.log.onAssignment(async (tx, ticket, change) => {
      if (change.fromId !== null && change.fromId !== change.toId)
        await this.end(tx, ticket, 'technician_changed');
      if (change.toId !== null)
        await this.proposeRequested(tx, ticket.id, change.toId);
    });
    this.log.onStatus(async (tx, ticket, change) => {
      if (change.to === 'cancelled')
        await this.end(tx, ticket, 'ticket_cancelled');
      else if (change.to === 'closed')
        await this.end(tx, ticket, 'ticket_closed');
      else if (change.to === 'completed')
        await this.end(tx, ticket, 'ticket_completed');
    });
    this.sweep.register(VISIT_LATE_SWEEP, (now) => this.late(now), {
      intervalMs: VISIT_LATE_INTERVAL_MS,
    });
  }

  /** The ticket's active visit ends by itself (the caller holds the ticket). */
  private async end(
    tx: TenantTxClient,
    ticket: Ticket,
    reason: SystemReason,
  ): Promise<void> {
    const visit = await this.visits.active(tx, ticket.id);
    if (!visit) return;
    const now = await dbNow(tx);
    // At the door already: whatever ended the ticket's work, the visit
    // happened, and it is over.
    if (visit.status === 'arrived') {
      await this.finish(tx, visit, now);
      return;
    }
    await this.visits.end(tx, ticket, visit, {
      status: 'cancelled',
      kind: 'cancelled',
      side: 'system',
      actorId: null,
      reasonCode: reason,
      now,
    });
    await this.visits.tell(
      tx,
      ticket,
      visit,
      'ticket.visit_cancelled',
      await this.visits.residents(tx, ticket),
    );
  }

  /**
   * A technician took a preventive ticket (ADR 0038): the window its
   * request asked for is proposed to them, from the residents' side, while
   * **the request still stands**:
   *
   * - every visit the ticket ever had was this automatic proposal, never
   *   confirmed, ended because the technician changed. Anything else — a resident or a
   *   technician cancelled or countered it, someone confirmed it, another
   *   visit was arranged — and the request is history;
   * - it still starts at least 15 minutes from now, by the database's
   *   clock (otherwise the technician proposes, as for any ticket);
   * - the reporter may still act on the ticket: nobody proposes in the
   *   name of someone who left.
   *
   * Under the ticket's lock (the assignment's), in its transaction: a
   * rolled-back assignment takes the proposal with it.
   */
  private async proposeRequested(
    tx: TenantTxClient,
    ticketId: string,
    technicianId: string,
  ): Promise<void> {
    // The row as the assignment left it.
    const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
    if (
      !ticket ||
      ticket.kind !== 'preventive' ||
      !ticket.requestedStartsAt ||
      !ticket.requestedEndsAt ||
      ticket.technicianId !== technicianId ||
      !can(ticket.status, 'visit')
    )
      return;
    const now = await dbNow(tx);
    if (ticket.requestedStartsAt.getTime() - now.getTime() < MIN_LEAD_MS)
      return;
    const visits = await tx.ticketVisit.findMany({
      where: { ticketId },
      select: {
        id: true,
        status: true,
        confirmedAt: true,
        cancelledBySide: true,
        cancelReasonCode: true,
      },
    });
    if (visits.length) {
      const automatic = new Set(
        (
          await tx.ticketVisitEvent.findMany({
            where: {
              ticketId,
              kind: 'proposed',
              reasonCode: 'preventive_request',
            },
            select: { visitId: true },
          })
        ).map((e) => e.visitId),
      );
      const stands = visits.every(
        (v) =>
          automatic.has(v.id) &&
          v.confirmedAt === null &&
          v.status === 'cancelled' &&
          v.cancelledBySide === 'system' &&
          v.cancelReasonCode === 'technician_changed',
      );
      if (!stands) return;
    }
    const reporter = await tx.account.findUnique({
      where: { id: ticket.reporterId },
      select: { status: true },
    });
    if (
      reporter?.status !== 'active' ||
      !(await this.access.mayOpen(tx, ticket.unitId, ticket.reporterId))
    )
      return;
    await this.visits.proposeRequested(
      tx,
      ticket,
      { startsAt: ticket.requestedStartsAt, endsAt: ticket.requestedEndsAt },
      now,
    );
  }

  private async finish(
    tx: TenantTxClient,
    visit: { id: string; tenantId: string; ticketId: string },
    now: Date,
  ): Promise<void> {
    await tx.ticketVisit.update({
      where: { id: visit.id },
      data: { status: 'done', finishedAt: now },
    });
    await this.visitLog.write(tx, visit, {
      kind: 'done',
      side: 'system',
      actorId: null,
      at: now,
    });
  }

  /**
   * Confirmed visits not arrived 15 minutes after their start, in every
   * active compound: claimed once (`late_notified_at`), so a rerun, another
   * instance or a retry never tells anyone twice. A visit whose row an
   * arrival holds is skipped and, arrived, never late.
   */
  late(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - LATE_AFTER_MS);
    return this.sweep.forEachTenant(async (tx, tenantId) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true },
      });
      if (tenant?.status !== 'active') return 0;
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE ticket_visits SET late_notified_at = ${now}, updated_at = ${now}
         WHERE id IN (
           SELECT id FROM ticket_visits
            WHERE status = 'confirmed' AND late_notified_at IS NULL
              AND starts_at <= ${cutoff}
            ORDER BY starts_at, id
            LIMIT ${LATE_BATCH}
              FOR UPDATE SKIP LOCKED)
        RETURNING id`;
      if (!claimed.length) return 0;
      const dispatchers = await this.notices.dispatchers(tx);
      for (const { id } of claimed) {
        const visit = await tx.ticketVisit.findUniqueOrThrow({ where: { id } });
        const ticket = await tx.ticket.findUniqueOrThrow({
          where: { id: visit.ticketId },
        });
        await this.visitLog.write(tx, visit, {
          kind: 'late_notified',
          side: 'system',
          actorId: null,
          at: now,
        });
        await this.visits.tell(tx, ticket, visit, 'ticket.visit_late', [
          ...(await this.visits.residents(tx, ticket)),
          ...dispatchers,
        ]);
      }
      return claimed.length;
    });
  }
}
