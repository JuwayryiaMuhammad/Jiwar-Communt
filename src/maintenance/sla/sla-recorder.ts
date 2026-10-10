import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type SlaClock,
  type SlaEventKind,
  type Ticket,
  type TicketSlaClock,
  type TicketStatus,
} from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { TicketLog, type StatusChange } from '../tickets/ticket-log';
import { TicketNotices } from '../tickets/ticket-notices';
import { fold, TERMINAL } from './sla-fold';
import { SlaSettingsService } from './sla-settings.service';
import { SlaTargetsService } from './sla-targets.service';

export const CLOCKS: readonly SlaClock[] = ['response', 'resolution'];

/** The hold reasons the clocks pause on (ADR 0032 left them for this). */
const PAUSING: ReadonlySet<string> = new Set([
  'awaiting_resident',
  'awaiting_parts',
]);

/** A ticket the SLA measures: not closed, not cancelled. */
export const MEASURED: readonly TicketStatus[] = [
  'new',
  'assigned',
  'en_route',
  'in_progress',
  'on_hold',
  'completed',
];

/** Stops that are not a judgement: they never turn into a breach. */
const NEUTRAL_STOPS: ReadonlySet<string> = new Set([
  'sla_disabled',
  'new_cycle',
]);

/** What a writer applies to a running clock; `started` and `breached` are the recorder's own. */
type AppliedKind = Exclude<SlaEventKind, 'started' | 'breached'>;

type SlaTicket = Pick<
  Ticket,
  | 'id'
  | 'tenantId'
  | 'number'
  | 'kind'
  | 'status'
  | 'holdReason'
  | 'priority'
  | 'categoryId'
>;

/**
 * The SLA measures repairs (ADR 0038): a check-up booked for next week is
 * not late after a day. A preventive ticket never has a clock, so it is
 * never breached, never overdue and never escalated.
 */
export const measures = (ticket: Pick<Ticket, 'kind'>): boolean =>
  ticket.kind !== 'preventive';

/**
 * Writes the SLA (ADR 0034): append-only events and, in the same
 * transaction, their projection. Every write happens under the ticket's row
 * lock (the caller's), with the database's clock read after it, and only
 * while the compound's SLA is on (read after the lock too, so a change of
 * the switch is ordered before or after it).
 *
 * - **Response** starts at creation and is met by the first visit proposal,
 *   the first `en_route` (ADR 0038) or the first `in_progress`; assignment
 *   alone is not a response.
 * - **Resolution** starts at creation, pauses at completion
 *   (`awaiting_confirmation`), resumes on a rejection and is met at close.
 * - Both pause on hold for the resident or for parts, resume when the
 *   ticket leaves that hold, and stop on cancellation.
 * - A reopen starts a new cycle; so does the first write after the SLA is
 *   turned on (never backdated: the clocks start at that write).
 * - A clock past its due time is breached, at exactly its due time,
 *   whoever writes next: the sweep, or a request that would have met it.
 *   `met` and `breached` are never both written (the projection says which
 *   came first, and a unique index backs it).
 * - Repairs only: a preventive ticket has no clocks (ADR 0038).
 */
@Injectable()
export class SlaRecorder implements OnModuleInit {
  constructor(
    private readonly log: TicketLog,
    private readonly settings: SlaSettingsService,
    private readonly targets: SlaTargetsService,
    private readonly notices: TicketNotices,
  ) {}

  onModuleInit(): void {
    this.log.onStatus((tx, ticket, change) =>
      this.onStatus(tx, ticket, change),
    );
  }

  /** The current activation's start, or null while the SLA is off. */
  async activation(tx: TenantTxClient): Promise<Date | null> {
    const s = await this.settings.inTx(tx);
    return s.slaEnabled ? s.enabledAt : null;
  }

  // --- the ticket's own changes ---------------------------------------------

  private async onStatus(
    tx: TenantTxClient,
    ticket: Ticket,
    change: StatusChange,
  ): Promise<void> {
    if (!measures(ticket)) return;
    const since = await this.activation(tx);
    if (!since) return;
    const now = await dbNow(tx);
    // Creation and reopen start a cycle of their own.
    if (change.from === null || change.from === 'closed') {
      await this.startCycle(
        tx,
        { ...ticket, status: change.to, holdReason: null },
        now,
        true,
      );
      return;
    }
    // A cancellation or a close ends what is running; it starts nothing.
    const current =
      change.to === 'cancelled' || change.to === 'closed'
        ? await this.current(tx, ticket.id, since)
        : await this.ensure(tx, ticket, since, now);
    if (!current) return;
    // Each event on a clock sees the one before it.
    const apply = async (
      clock: SlaClock,
      kind: AppliedKind,
      reason: string | null,
    ) => {
      const after = await this.apply(
        tx,
        ticket,
        current.get(clock),
        kind,
        now,
        reason,
      );
      if (after) current.set(clock, after);
    };

    if (change.to === 'cancelled') {
      for (const clock of CLOCKS)
        await apply(clock, 'stopped', 'ticket_cancelled');
      return;
    }
    if (change.to === 'closed') {
      for (const clock of CLOCKS) await apply(clock, 'met', null);
      return;
    }
    if (change.from === 'on_hold' && PAUSING.has(ticket.holdReason ?? ''))
      for (const clock of CLOCKS) await apply(clock, 'resumed', 'left_hold');
    if (change.from === 'completed')
      await apply('resolution', 'resumed', 'rejected');
    if (change.to === 'en_route' || change.to === 'in_progress')
      await apply('response', 'met', null);
    if (change.to === 'on_hold' && PAUSING.has(change.reasonCode ?? ''))
      for (const clock of CLOCKS)
        await apply(clock, 'paused', change.reasonCode!);
    if (change.to === 'completed')
      await apply('resolution', 'paused', 'awaiting_confirmation');
  }

  /**
   * A response other than a status: the first visit proposal from the
   * technician's side (ADR 0034). Under the ticket's lock.
   */
  async responded(tx: TenantTxClient, ticket: Ticket): Promise<void> {
    const since = await this.activation(tx);
    if (!since) return;
    const now = await dbNow(tx);
    const current = await this.ensure(tx, ticket, since, now);
    if (current)
      await this.apply(tx, ticket, current.get('response'), 'met', now, null);
  }

  /**
   * The ticket's priority or category changed (`ticket` is the row after
   * it): its running and paused clocks take the new target, measured from
   * the same start. A running clock that is then already past due is
   * breached now.
   */
  async retarget(
    tx: TenantTxClient,
    ticket: Ticket,
    reason: 'priority_changed' | 'category_changed',
  ): Promise<void> {
    const since = await this.activation(tx);
    if (!since) return;
    const now = await dbNow(tx);
    const current = await this.ensure(tx, ticket, since, now);
    if (!current) return;
    const target = await this.targets.forTicket(tx, ticket);
    for (const clock of CLOCKS) {
      const minutes =
        clock === 'response'
          ? target.responseMinutes
          : target.resolutionMinutes;
      const c = current.get(clock);
      if (!c || TERMINAL.has(c.state) || c.targetMinutes === minutes) continue;
      const after = await this.apply(
        tx,
        ticket,
        c,
        'retargeted',
        now,
        reason,
        minutes,
      );
      if (after?.state === 'running' && after.dueAt && after.dueAt <= now)
        await this.breach(tx, ticket, after, now);
    }
  }

  /**
   * Time decides, not the sweep (ADR 0038): the ticket's running clocks
   * already past due are breached now, at their due time, for a caller
   * that is about to judge whether the ticket is overdue. Under the
   * ticket's lock. It starts nothing and stops nothing.
   */
  async settle(tx: TenantTxClient, ticket: SlaTicket): Promise<void> {
    const since = await this.activation(tx);
    if (!since) return;
    const now = await dbNow(tx);
    const current = await this.current(tx, ticket.id, since);
    if (!current) return;
    for (const c of current.values())
      if (c.state === 'running' && c.dueAt && c.dueAt <= now)
        await this.breach(tx, ticket, c, c.dueAt);
  }

  // --- the sweep, activation and deactivation ------------------------------

  /**
   * One clock past due, from the sweep, under the ticket's lock (taken
   * here). Breached at exactly its due time, once.
   */
  async breachDue(
    tx: TenantTxClient,
    key: { ticketId: string; cycle: number; clock: SlaClock },
    now: Date,
  ): Promise<number> {
    await tx.$queryRaw`
      SELECT id FROM tickets WHERE id = ${key.ticketId}::uuid FOR UPDATE`;
    if (!(await this.activation(tx))) return 0;
    // RLS scopes the read to the sweep's compound.
    const c = await tx.ticketSlaClock.findFirst({
      where: { ticketId: key.ticketId, cycle: key.cycle, clock: key.clock },
    });
    if (!c || c.state !== 'running' || !c.dueAt || c.dueAt > now) return 0;
    const ticket = await tx.ticket.findUniqueOrThrow({
      where: { id: key.ticketId },
    });
    await this.breach(tx, ticket, c, c.dueAt);
    return 1;
  }

  /**
   * Brings one ticket in line with the switch, under its lock (taken here):
   * on, the current activation's clocks are started if missing; off, the
   * clocks still running or paused are stopped. Idempotent.
   */
  async reconcile(tx: TenantTxClient, ticketId: string): Promise<number> {
    await tx.$queryRaw`
      SELECT id FROM tickets WHERE id = ${ticketId}::uuid FOR UPDATE`;
    const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) return 0;
    const since = await this.activation(tx);
    const now = await dbNow(tx);
    if (since) return (await this.ensure(tx, ticket, since, now)) ? 1 : 0;
    let stopped = 0;
    for (const c of await this.open(tx, ticketId)) {
      await this.apply(tx, ticket, c, 'stopped', now, 'sla_disabled');
      stopped++;
    }
    return stopped;
  }

  // --- the clocks ------------------------------------------------------------

  /**
   * The current activation's clocks of the ticket, by clock; started now
   * when the SLA is on and the ticket has none yet (the first write after
   * turning it on). Null for a ticket the SLA no longer measures.
   */
  private async ensure(
    tx: TenantTxClient,
    ticket: SlaTicket,
    since: Date,
    now: Date,
  ): Promise<Map<SlaClock, TicketSlaClock> | null> {
    const current = await this.current(tx, ticket.id, since);
    if (current) return current;
    if (!MEASURED.includes(ticket.status) || !measures(ticket)) return null;
    return this.startCycle(
      tx,
      ticket,
      now,
      !(await this.hasResponded(tx, ticket.id)),
    );
  }

  /** The latest cycle's clocks, if it belongs to this activation. */
  async current(
    tx: TenantTxClient,
    ticketId: string,
    since: Date,
  ): Promise<Map<SlaClock, TicketSlaClock> | null> {
    const all = await tx.ticketSlaClock.findMany({
      where: { ticketId },
      orderBy: [{ cycle: 'desc' }],
    });
    const cycle = all[0]?.cycle;
    const current = all.filter(
      (c) => c.cycle === cycle && c.startedAt >= since,
    );
    return current.length ? new Map(current.map((c) => [c.clock, c])) : null;
  }

  /**
   * A new cycle: earlier clocks still open are stopped (never resumed), the
   * resolution clock starts (paused at once on a pausing hold or while the
   * work waits for confirmation), and the response clock too unless the
   * ticket has already been responded to.
   */
  private async startCycle(
    tx: TenantTxClient,
    ticket: SlaTicket,
    now: Date,
    response: boolean,
  ): Promise<Map<SlaClock, TicketSlaClock>> {
    for (const c of await this.open(tx, ticket.id))
      await this.apply(tx, ticket, c, 'stopped', now, 'new_cycle');
    const last = await tx.ticketSlaClock.aggregate({
      where: { ticketId: ticket.id },
      _max: { cycle: true },
    });
    const cycle = (last._max.cycle ?? 0) + 1;
    const target = await this.targets.forTicket(tx, ticket);
    const out = new Map<SlaClock, TicketSlaClock>();
    if (response)
      out.set(
        'response',
        await this.append(
          tx,
          ticket,
          cycle,
          'response',
          'started',
          now,
          target.responseMinutes,
          null,
        ),
      );
    let resolution = await this.append(
      tx,
      ticket,
      cycle,
      'resolution',
      'started',
      now,
      target.resolutionMinutes,
      null,
    );
    const pause =
      ticket.status === 'completed'
        ? 'awaiting_confirmation'
        : ticket.status === 'on_hold' && PAUSING.has(ticket.holdReason ?? '')
          ? ticket.holdReason!
          : null;
    if (pause)
      resolution = await this.append(
        tx,
        ticket,
        cycle,
        'resolution',
        'paused',
        now,
        resolution.targetMinutes,
        pause,
      );
    out.set('resolution', resolution);
    return out;
  }

  /**
   * One event on a clock, unless it no longer applies (an ended clock, a
   * pause of a paused one). A running clock past its due time is breached
   * at its due time instead: the event came too late to change that.
   */
  private async apply(
    tx: TenantTxClient,
    ticket: SlaTicket,
    c: TicketSlaClock | undefined,
    kind: AppliedKind,
    now: Date,
    reason: string | null,
    target = c?.targetMinutes,
  ): Promise<TicketSlaClock | null> {
    if (!c || TERMINAL.has(c.state)) return null;
    if (
      c.state === 'running' &&
      c.dueAt &&
      c.dueAt <= now &&
      !(kind === 'stopped' && reason !== null && NEUTRAL_STOPS.has(reason))
    )
      return this.breach(tx, ticket, c, c.dueAt);
    if (kind === 'paused' && c.state !== 'running') return c;
    if (kind === 'resumed' && c.state !== 'paused') return c;
    return this.append(
      tx,
      ticket,
      c.cycle,
      c.clock,
      kind,
      now,
      target!,
      reason,
    );
  }

  /** Breached at `at`, and the dispatchers and managers are told. */
  private async breach(
    tx: TenantTxClient,
    ticket: SlaTicket,
    c: TicketSlaClock,
    at: Date,
  ): Promise<TicketSlaClock> {
    const after = await this.append(
      tx,
      ticket,
      c.cycle,
      c.clock,
      'breached',
      at,
      c.targetMinutes,
      null,
    );
    const to = [
      ...(await this.notices.holding(tx, 'tickets.dispatch')),
      ...(await this.notices.holding(tx, 'maintenance.manage')),
    ];
    await this.notices.sendBare(
      tx,
      to,
      ticket.priority === 'emergency'
        ? 'ticket.sla_breached_emergency'
        : 'ticket.sla_breached',
      ticket,
      { clock: c.clock },
    );
    return after;
  }

  /**
   * Appends one event and rewrites the clock's projection from all of its
   * events, in this transaction: the projection is always the fold.
   */
  private async append(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'tenantId'>,
    cycle: number,
    clock: SlaClock,
    kind: SlaEventKind,
    at: Date,
    targetMinutes: number,
    reasonCode: string | null,
  ): Promise<TicketSlaClock> {
    const events = await tx.ticketSlaEvent.findMany({
      where: { ticketId: ticket.id, cycle, clock },
      orderBy: { seq: 'asc' },
    });
    const event = await tx.ticketSlaEvent.create({
      data: {
        id: newId(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        cycle,
        clock,
        seq: (events[events.length - 1]?.seq ?? 0) + 1,
        kind,
        at,
        targetMinutes,
        reasonCode,
      },
    });
    const p = fold([...events, event]);
    return tx.ticketSlaClock.upsert({
      where: {
        tenantId_ticketId_cycle_clock: {
          tenantId: ticket.tenantId,
          ticketId: ticket.id,
          cycle,
          clock,
        },
      },
      create: {
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        cycle,
        clock,
        ...p,
      },
      update: p,
    });
  }

  /** The ticket's clocks still running or paused, any cycle. */
  private open(tx: TenantTxClient, ticketId: string) {
    return tx.ticketSlaClock.findMany({
      where: { ticketId, state: { in: ['running', 'paused'] } },
      orderBy: [{ cycle: 'asc' }, { clock: 'asc' }],
    });
  }

  private async hasResponded(
    tx: TenantTxClient,
    ticketId: string,
  ): Promise<boolean> {
    return (await this.respondedAmong(tx, [ticketId])).has(ticketId);
  }

  /**
   * Which of these tickets were responded to since they were opened or
   * last reopened: they went `en_route` or `in_progress`, or a visit was
   * proposed by the technician's side. One query for all of them.
   */
  async respondedAmong(
    tx: TenantTxClient,
    ticketIds: readonly string[],
  ): Promise<Set<string>> {
    if (!ticketIds.length) return new Set();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM unnest(${[...ticketIds]}::uuid[]) AS t(id)
       WHERE ${respondedSql(Prisma.sql`t.id`)}`;
    return new Set(rows.map((r) => r.id));
  }
}

/**
 * "Responded to since it was opened or last reopened", as a SQL condition on
 * the ticket whose id is `id`. The one definition: `respondedAmong` and the
 * dispatch list's `overdue` filter both read it, so they cannot disagree.
 */
export function respondedSql(id: Prisma.Sql): Prisma.Sql {
  const since = Prisma.sql`
    COALESCE((SELECT max(r.created_at)
                FROM ticket_status_history r
               WHERE r.ticket_id = ${id}
                 AND r.from_status = 'closed'),
             '-infinity'::timestamptz)`;
  return Prisma.sql`(
    EXISTS (
      SELECT 1 FROM ticket_status_history h
       WHERE h.ticket_id = ${id}
         AND h.to_status IN ('en_route', 'in_progress')
         AND h.created_at >= ${since})
    OR EXISTS (
      SELECT 1 FROM ticket_visits v
       WHERE v.ticket_id = ${id}
         AND v.proposed_by_side = 'technician'
         AND v.created_at >= ${since}))`;
}
