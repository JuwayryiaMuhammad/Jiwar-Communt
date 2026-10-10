import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type SlaClock,
  type SlaClockState,
  type Ticket,
  type TicketSlaEvent,
  type TicketSlaClock,
} from '@prisma/client';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { TicketAccess } from '../tickets/ticket-access';
import { AWAITED, overdueClocks } from './sla-overdue';
import { respondedSql, SlaRecorder } from './sla-recorder';

/** What a ticket's view shows of its SLA (ADR 0034). */
export interface SlaSummary {
  /** The SLA's own cycle (ADR 0034); not shown, the escalation's key. */
  cycle: number;
  /** While the response clock runs: when it is due. */
  responseDueAt: Date | null;
  /** While the resolution clock runs: when it is due. */
  resolutionDueAt: Date | null;
  /** A clock is paused (waiting for the resident, parts or a confirmation). */
  paused: boolean;
  responseState: SlaClockState | null;
  resolutionState: SlaClockState | null;
  /** The late, unmet commitments (ADR 0038); `overdue` is "any". */
  overdueClocks: SlaClock[];
  overdue: boolean;
}

type SlaTicket = Pick<Ticket, 'id' | 'status'>;

/**
 * Reads the SLA (ADR 0034): a ticket's current clocks for its views, and
 * its events for dispatch. Nothing while the SLA is off.
 */
@Injectable()
export class SlaService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly access: TicketAccess,
    private readonly recorder: SlaRecorder,
  ) {}

  /** The current activation's clocks, or null (off, or none yet). */
  async summary(
    tx: TenantTxClient,
    ticket: SlaTicket,
  ): Promise<SlaSummary | null> {
    return (await this.summaries(tx, [ticket])).get(ticket.id) ?? null;
  }

  /**
   * The same for a page of tickets, in a fixed number of queries whatever
   * its size (ADR 0038): the switch, the clocks, who was responded to, and
   * the database's clock for "overdue". A ticket without current clocks
   * has no entry. A caller that already filtered by `conditions` passes
   * the same `now`, so its rows say what its filter said.
   */
  async summaries(
    tx: TenantTxClient,
    tickets: readonly SlaTicket[],
    at?: Date,
  ): Promise<Map<string, SlaSummary>> {
    const out = new Map<string, SlaSummary>();
    if (!tickets.length) return out;
    const since = await this.recorder.activation(tx);
    if (!since) return out;
    const all = await tx.ticketSlaClock.findMany({
      where: { ticketId: { in: tickets.map((t) => t.id) } },
      orderBy: [{ cycle: 'desc' }],
    });
    // Per ticket: the latest cycle's clocks, if it is this activation's.
    const current = new Map<string, TicketSlaClock[]>();
    const latest = new Map<string, number>();
    for (const c of all) {
      if (!latest.has(c.ticketId)) latest.set(c.ticketId, c.cycle);
      if (c.cycle !== latest.get(c.ticketId) || c.startedAt < since) continue;
      current.set(c.ticketId, [...(current.get(c.ticketId) ?? []), c]);
    }
    if (!current.size) return out;
    const responded = await this.recorder.respondedAmong(tx, [
      ...current.keys(),
    ]);
    const now = at ?? (await dbNow(tx));
    const due = (c: TicketSlaClock | undefined) =>
      c?.state === 'running' ? c.dueAt : null;
    for (const t of tickets) {
      const clocks = current.get(t.id);
      if (!clocks) continue;
      const response = clocks.find((c) => c.clock === 'response');
      const resolution = clocks.find((c) => c.clock === 'resolution');
      const overdue = overdueClocks({
        status: t.status,
        responded: responded.has(t.id),
        clocks,
        now,
      });
      out.set(t.id, {
        cycle: clocks[0].cycle,
        responseDueAt: due(response),
        resolutionDueAt: due(resolution),
        paused: clocks.some((c) => c.state === 'paused'),
        responseState: response?.state ?? null,
        resolutionState: resolution?.state ?? null,
        overdueClocks: overdue,
        overdue: overdue.length > 0,
      });
    }
    return out;
  }

  /**
   * The dispatch list's `overdue` and `escalated` filters (ADR 0034), as SQL
   * conditions on `tickets t`: the same facts `summaries` reads, decided by
   * the database so a filtered list still pages by keyset. Null while the
   * SLA is off: no ticket is overdue or escalated then.
   *
   * - current clocks: the ticket's latest SLA cycle, if this activation's;
   * - overdue: `overdueClocks`, in SQL (a test holds the two together);
   * - escalated: an escalation of that same cycle.
   */
  async conditions(
    tx: TenantTxClient,
    want: { overdue?: boolean; escalated?: boolean },
    now: Date,
  ): Promise<Prisma.Sql[] | null> {
    const since = await this.recorder.activation(tx);
    if (!since) return null;
    const current = Prisma.sql`
      c.cycle = (SELECT max(m.cycle) FROM ticket_sla_clocks m
                  WHERE m.ticket_id = t.id)
      AND c.started_at >= ${since}::timestamptz`;
    const out: Prisma.Sql[] = [];
    if (want.overdue)
      out.push(Prisma.sql`
        t.status::text IN (${Prisma.join([...AWAITED])})
        AND EXISTS (
          SELECT 1 FROM ticket_sla_clocks c
           WHERE c.ticket_id = t.id
             AND ${current}
             AND (c.state = 'breached'
                  OR (c.state = 'running' AND c.due_at <= ${now}::timestamptz))
             AND (c.clock = 'resolution'
                  OR NOT ${respondedSql(Prisma.sql`t.id`)}))`);
    if (want.escalated)
      out.push(Prisma.sql`
        EXISTS (
          SELECT 1 FROM ticket_escalations e
            JOIN ticket_sla_clocks c
              ON c.ticket_id = e.ticket_id AND c.cycle = e.sla_cycle
           WHERE e.ticket_id = t.id
             AND ${current})`);
    return out;
  }

  /** Dispatch: every SLA event of the ticket, oldest first. */
  events(ticketId: string): Promise<TicketSlaEvent[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, ticketId, 'dispatch');
      return tx.ticketSlaEvent.findMany({
        where: { ticketId },
        orderBy: [{ cycle: 'asc' }, { clock: 'asc' }, { seq: 'asc' }],
      });
    });
  }
}
