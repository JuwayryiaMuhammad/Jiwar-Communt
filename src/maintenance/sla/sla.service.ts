import { Injectable } from '@nestjs/common';
import type {
  SlaClockState,
  TicketSlaEvent,
  TicketSlaClock,
} from '@prisma/client';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TicketAccess } from '../tickets/ticket-access';
import { SlaRecorder } from './sla-recorder';

/** What a ticket's view shows of its SLA (ADR 0034). */
export interface SlaSummary {
  /** While the response clock runs: when it is due. */
  responseDueAt: Date | null;
  /** While the resolution clock runs: when it is due. */
  resolutionDueAt: Date | null;
  /** A clock is paused (waiting for the resident, parts or a confirmation). */
  paused: boolean;
  responseState: SlaClockState | null;
  resolutionState: SlaClockState | null;
}

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
    ticketId: string,
  ): Promise<SlaSummary | null> {
    const since = await this.recorder.activation(tx);
    if (!since) return null;
    const current = await this.recorder.current(tx, ticketId, since);
    if (!current) return null;
    const response = current.get('response');
    const resolution = current.get('resolution');
    const due = (c: TicketSlaClock | undefined) =>
      c?.state === 'running' ? c.dueAt : null;
    return {
      responseDueAt: due(response),
      resolutionDueAt: due(resolution),
      paused: [response, resolution].some((c) => c?.state === 'paused'),
      responseState: response?.state ?? null,
      resolutionState: resolution?.state ?? null,
    };
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
