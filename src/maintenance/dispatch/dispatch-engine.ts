import { Injectable, Logger } from '@nestjs/common';
import type { DispatchTrigger, Ticket } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TicketLog } from '../tickets/ticket-log';
import { TicketNotices } from '../tickets/ticket-notices';
import { candidateFilter } from './candidates';
import { DispatchBusyError, isLockTimeout } from './dispatch-busy';
import { DispatchLimiter } from './dispatch-limiter';
import { DispatchSettingsService } from './dispatch-settings.service';
import {
  lastAssigned,
  rank,
  scaleWeights,
  workloadOf,
  openCounts,
  type Candidate,
} from './workload';

/** What a run of the engine on one ticket did. */
export type DispatchResult =
  | { outcome: 'assigned'; technicianId: string }
  | { outcome: 'no_candidate' }
  | { outcome: 'skipped'; reason: 'auto_dispatch_disabled' }
  /** Not `new` with no technician any more: someone else got there first. */
  | { outcome: 'not_in_queue' };

/** Tickets the "became available" walk looks at in one go. */
export const QUEUE_BATCH = 20;

/**
 * How long a decision waits for the dispatch lock. A decision takes tens of
 * milliseconds, so waiting longer means something is wrong, and a waiter
 * holds a database connection; well under Prisma's 10 s transaction limit.
 */
export const LOCK_WAIT_MS = 3000;

/**
 * The triggers that act on a ticket and so leave a `skipped` row when
 * automatic dispatch is off. The sweep and the "available" walk do nothing
 * at all then: they would repeat the row for every queued ticket.
 */
const RECORDS_SKIP: readonly DispatchTrigger[] = [
  'created',
  'declined',
  'role_lost',
  'released',
];

/**
 * The dispatch engine (ADR 0033): gives a ticket in the queue to the best
 * technician, or says why it could not. A service of its own so the
 * algorithm can change without touching the ticket lifecycle; it writes the
 * same history rows and sends the same notices manual assignment does.
 *
 * Decisions in a compound are **serialized** with a transaction-level
 * advisory lock on (tenant, dispatch), so two tickets created at the same
 * moment never both pick the same "least loaded" technician from a view
 * that is one decision old. The lock is the first one a transaction takes
 * in the dispatch order (advisory lock, account row, ticket row): a caller
 * that locks the ticket itself must call `serialize` before.
 */
@Injectable()
export class DispatchEngine {
  private readonly logger = new Logger(DispatchEngine.name);

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly limiter: DispatchLimiter,
    private readonly settings: DispatchSettingsService,
    private readonly log: TicketLog,
    private readonly notices: TicketNotices,
  ) {}

  /**
   * The compound's dispatch lock, held until the transaction ends, waiting
   * at most `waitMs` for it (a lock timeout scoped to this one statement):
   * a transaction must never sit on a pool connection behind a lock held far
   * longer than a decision. Taking it twice in one transaction is free.
   * Throws DispatchBusyError when it could not be had.
   */
  async serialize(
    tx: TenantTxClient,
    waitMs: number = LOCK_WAIT_MS,
  ): Promise<void> {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${waitMs}ms`}, true)`;
    try {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended('maintenance.dispatch:' || current_setting('app.tenant_id'), 0))`;
    } catch (error) {
      if (isLockTimeout(error)) throw new DispatchBusyError();
      throw error;
    } finally {
      // Only after a success is the transaction still usable.
      await tx.$executeRaw`SELECT set_config('lock_timeout', '0', true)`.catch(
        () => undefined,
      );
    }
  }

  /**
   * Tries to give the ticket to a technician: **one decision**, the unit the
   * dispatch lock is held for. Acts only if it is `new` with no technician,
   * under its row lock: run twice, it assigns once. Errors propagate.
   */
  async run(
    tx: TenantTxClient,
    ticketId: string,
    trigger: DispatchTrigger,
  ): Promise<DispatchResult> {
    await this.serialize(tx);
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticketId}::uuid FOR UPDATE`;
    const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket || ticket.status !== 'new' || ticket.technicianId !== null)
      return { outcome: 'not_in_queue' };

    const settings = await this.settings.inTx(tx);
    if (!settings.autoDispatchEnabled && trigger !== 'manual') {
      if (!RECORDS_SKIP.includes(trigger))
        return { outcome: 'skipped', reason: 'auto_dispatch_disabled' };
      await this.record(tx, ticket, trigger, {
        outcome: 'skipped',
        candidateCount: 0,
        reasonCode: 'auto_dispatch_disabled',
      });
      return { outcome: 'skipped', reason: 'auto_dispatch_disabled' };
    }

    const filter = await candidateFilter(tx, ticket);
    const found = (
      await tx.account.findMany({
        where: filter,
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((a) => a.id);
    if (found.length) {
      const chosen = await this.choose(tx, found, filter, settings);
      if (chosen) {
        await this.assign(tx, ticket, chosen, trigger, found.length);
        return { outcome: 'assigned', technicianId: chosen };
      }
    }
    await this.noCandidate(tx, ticket, trigger);
    return { outcome: 'no_candidate' };
  }

  /**
   * The tickets, each decided in a transaction of its own (so the dispatch
   * lock is held for one decision, never a batch), in the request's
   * compound, AFTER the transaction that caused them committed: a resident's
   * ticket, a decline, a release, an availability change. A failure, or the
   * compound being busy, is logged and skipped: the ticket is in the queue
   * and the sweep retries. Returns how many were assigned.
   */
  async dispatch(
    ticketIds: readonly string[],
    trigger: DispatchTrigger,
  ): Promise<number> {
    let assigned = 0;
    for (const id of ticketIds) {
      const tenantId = this.ctx.tenantId;
      try {
        const result = await this.limiter.run(tenantId, () =>
          this.tenantTx.withTenantTx((tx) => this.run(tx, id, trigger)),
        );
        if (result?.outcome === 'assigned') assigned++;
      } catch (error) {
        // The limiter already put the compound in backoff (it must be marked
        // before the next waiter starts, which is before this runs).
        if (error instanceof DispatchBusyError)
          this.logger.warn('dispatch lock busy: ticket left to the sweep');
        else
          this.logger.error(
            `dispatch failed for a ticket (${error instanceof Error ? error.name : 'Error'})`,
          );
      }
    }
    return assigned;
  }

  /**
   * A technician just became available: the queued tickets they could take
   * (their specialties, never one they declined), emergency first, then
   * urgent, then normal, oldest first within each, a bounded batch. Each is
   * decided on its own with the full choice, so the least loaded candidate
   * wins, not automatically the one who just came back; once they carry load
   * the next ticket goes to someone else. What is left waits for the sweep.
   * Does nothing while automatic dispatch is off.
   */
  async dispatchQueueFor(technicianId: string): Promise<number> {
    const ids = await this.tenantTx.withTenantTx((tx) =>
      this.queueFor(tx, technicianId),
    );
    return this.dispatch(ids, 'available');
  }

  /** The queue a technician could take, best first (no lock needed). */
  private async queueFor(
    tx: TenantTxClient,
    technicianId: string,
  ): Promise<string[]> {
    if (!(await this.settings.inTx(tx)).autoDispatchEnabled) return [];
    const declined = (
      await tx.ticketAssignment.findMany({
        where: { fromId: technicianId, assignmentType: 'declined' },
        select: { ticketId: true },
      })
    ).map((r) => r.ticketId);
    const queue = await tx.ticket.findMany({
      where: {
        status: 'new',
        technicianId: null,
        id: { notIn: declined },
        category: {
          OR: [
            { specialties: { none: { specialty: { active: true } } } },
            {
              specialties: {
                some: {
                  specialty: {
                    active: true,
                    technicians: {
                      some: { accountId: technicianId, active: true },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      // Enum order is declaration order: normal, urgent, emergency.
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: QUEUE_BATCH,
      select: { id: true },
    });
    return queue.map((t) => t.id);
  }

  /**
   * Tickets that just went back to the queue because their technician can
   * no longer work: tried again at once, after the transaction that released
   * them committed. That one (a deactivation, a freeze, an erasure, a role
   * change) stays free of the engine; an emergency does not wait for the
   * sweep.
   */
  afterRelease(
    ticketIds: readonly string[],
    trigger: DispatchTrigger = 'released',
  ): Promise<number> {
    return this.dispatch(ticketIds, trigger);
  }

  /**
   * The first of `found`, best first, that is still a candidate once its
   * account is locked `FOR SHARE`: a deactivation, a role change or an
   * availability change committing at this moment is ordered before or
   * after the assignment, never inside it.
   */
  private async choose(
    tx: TenantTxClient,
    found: string[],
    filter: Awaited<ReturnType<typeof candidateFilter>>,
    settings: Awaited<ReturnType<DispatchSettingsService['inTx']>>,
  ): Promise<string | null> {
    const weights = scaleWeights(settings);
    const [open, last] = await Promise.all([
      openCounts(tx, found),
      lastAssigned(tx, found),
    ]);
    const candidates: Candidate[] = found.map((id) => ({
      id,
      workload: workloadOf(open.get(id) ?? [], weights),
      lastAssignedAt: last.get(id) ?? null,
    }));
    for (const c of rank(candidates)) {
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${c.id}::uuid FOR SHARE`;
      const still = await tx.account.count({
        where: { AND: [filter, { id: c.id }] },
      });
      if (still) return c.id;
    }
    return null;
  }

  private async assign(
    tx: TenantTxClient,
    ticket: Ticket,
    technicianId: string,
    trigger: DispatchTrigger,
    candidateCount: number,
  ): Promise<void> {
    const updated = await tx.ticket.update({
      where: { id: ticket.id },
      data: { status: 'assigned', technicianId, assignedAt: new Date() },
    });
    await this.log.assignment(tx, ticket, {
      type: 'automatic',
      fromId: null,
      toId: technicianId,
      assignedById: null,
      cycle: ticket.cycle,
    });
    await this.log.status(tx, ticket, {
      from: 'new',
      to: 'assigned',
      actorId: null,
      cycle: ticket.cycle,
    });
    await this.record(tx, ticket, trigger, {
      outcome: 'assigned',
      candidateCount,
      technicianId,
    });
    await this.notices.assigned(tx, updated, technicianId);
    await this.notices.send(
      tx,
      [ticket.reporterId],
      'ticket.status_changed',
      ticket,
      { status: 'assigned' },
    );
  }

  /**
   * Nobody can take it: the ticket stays in the queue. The dispatchers are
   * told once per ticket and cycle, however many times the engine tries
   * again (the sweep, a decline, a manual request).
   */
  private async noCandidate(
    tx: TenantTxClient,
    ticket: Ticket,
    trigger: DispatchTrigger,
  ): Promise<void> {
    const told = await tx.ticketDispatchAttempt.count({
      where: { ticketId: ticket.id, cycle: ticket.cycle, notified: true },
    });
    await this.record(tx, ticket, trigger, {
      outcome: 'no_candidate',
      candidateCount: 0,
      notified: told === 0,
    });
    if (told === 0) await this.notices.unassignable(tx, ticket);
  }

  private async record(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'tenantId' | 'cycle'>,
    trigger: DispatchTrigger,
    row: {
      outcome: 'assigned' | 'no_candidate' | 'skipped';
      candidateCount: number;
      technicianId?: string;
      reasonCode?: string;
      notified?: boolean;
    },
  ): Promise<void> {
    await tx.ticketDispatchAttempt.create({
      data: {
        id: newId(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        cycle: ticket.cycle,
        trigger,
        outcome: row.outcome,
        candidateCount: row.candidateCount,
        technicianId: row.technicianId ?? null,
        reasonCode: row.reasonCode ?? null,
        notified: row.notified ?? false,
      },
    });
  }
}
