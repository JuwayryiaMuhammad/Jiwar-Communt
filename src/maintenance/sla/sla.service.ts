import { Injectable } from '@nestjs/common';
import type {
  SlaClock,
  SlaClockState,
  Ticket,
  TicketSlaEvent,
  TicketSlaClock,
} from '@prisma/client';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { TicketAccess } from '../tickets/ticket-access';
import { overdueClocks } from './sla-overdue';
import { SlaRecorder } from './sla-recorder';

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
   * has no entry.
   */
  async summaries(
    tx: TenantTxClient,
    tickets: readonly SlaTicket[],
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
    const now = await dbNow(tx);
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
