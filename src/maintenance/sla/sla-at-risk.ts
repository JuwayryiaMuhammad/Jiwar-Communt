import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type SlaClock, type TicketPriority } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TicketNotices } from '../tickets/ticket-notices';
import { SlaRecorder } from './sla-recorder';

export const SLA_AT_RISK_SWEEP = 'maintenance.sla_at_risk';
/** A clock comes at risk at a minute, like a breach (ADR 0034). */
export const SLA_AT_RISK_INTERVAL_MS = 60_000;
/** Clocks one run warns of per compound. */
export const AT_RISK_BATCH = 500;

interface AtRisk {
  ticketId: string;
  cycle: number;
  clock: SlaClock;
}

/** The share of a clock's target, per priority, as the settings keep it. */
const PERCENT = Prisma.sql`(CASE t.priority
  WHEN 'normal' THEN s.at_risk_percent_normal
  WHEN 'urgent' THEN s.at_risk_percent_urgent
  ELSE s.at_risk_percent_emergency END)`;

/**
 * The SLA's first escalation level (ADR 0076): a running clock that has
 * used its compound's share of its target at the ticket's priority
 * (`at_risk_percent_*`, 75 % by default; none where the share is null) is
 * at risk. The technician holding the ticket and the dispatch
 * (`tickets.dispatch`) are told once per clock and SLA cycle; the breach
 * (ADR 0034) still tells the dispatch and the managers.
 *
 * Every minute, in compounds with the SLA on and not suspended; each clock
 * in a transaction of its own under its ticket's row lock, where the clock
 * is read again: a clock met, paused, breached or retargeted meanwhile is
 * left (a retarget moves its due time, and the share is the new target's).
 * The "once" is `ticket_sla_alerts`' key, written with the notices.
 */
@Injectable()
export class SlaAtRisk implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly recorder: SlaRecorder,
    private readonly notices: TicketNotices,
  ) {}

  onModuleInit(): void {
    this.sweep.register(SLA_AT_RISK_SWEEP, (now) => this.run(now), {
      intervalMs: SLA_AT_RISK_INTERVAL_MS,
    });
  }

  /** Clocks warned of across the compounds. */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true },
        });
        if (tenant?.status !== 'active') return [];
        if (!(await this.recorder.activation(tx))) return [];
        return this.due(tx, now, null, AT_RISK_BATCH);
      },
      (tx, _tenantId, one) => this.warn(tx, one, now),
    );
  }

  /** The running clocks past their share and not yet warned of. */
  private due(
    tx: TenantTxClient,
    now: Date,
    only: AtRisk | null,
    limit: number,
  ): Promise<AtRisk[]> {
    return tx.$queryRaw<AtRisk[]>`
      SELECT c.ticket_id AS "ticketId", c.cycle, c.clock::text AS clock
        FROM ticket_sla_clocks c
        JOIN tickets t ON t.id = c.ticket_id
        JOIN maintenance_sla_settings s ON s.tenant_id = c.tenant_id
       WHERE c.state = 'running' AND c.due_at > ${now}
         AND ${PERCENT} IS NOT NULL
         AND c.due_at - (c.target_minutes * (100 - ${PERCENT})) * interval '600 milliseconds' <= ${now}
         AND NOT EXISTS (
           SELECT 1 FROM ticket_sla_alerts a
            WHERE a.tenant_id = c.tenant_id AND a.ticket_id = c.ticket_id
              AND a.cycle = c.cycle AND a.clock = c.clock AND a.level = 'at_risk')
         ${
           only
             ? Prisma.sql`AND c.ticket_id = ${only.ticketId}::uuid AND c.cycle = ${only.cycle}
                          AND c.clock = ${only.clock}::sla_clock`
             : Prisma.empty
         }
       ORDER BY c.due_at, c.ticket_id
       LIMIT ${limit}`;
  }

  /** One clock, under its ticket's lock: still at risk, then warned once. */
  private async warn(
    tx: TenantTxClient,
    one: AtRisk,
    now: Date,
  ): Promise<number> {
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${one.ticketId}::uuid FOR UPDATE`;
    if (!(await this.due(tx, now, one, 1)).length) return 0;
    const written = await tx.$executeRaw`
      INSERT INTO ticket_sla_alerts (tenant_id, ticket_id, cycle, clock, level, created_at)
      SELECT tenant_id, id, ${one.cycle}, ${one.clock}::sla_clock, 'at_risk', ${now}
        FROM tickets WHERE id = ${one.ticketId}::uuid
      ON CONFLICT DO NOTHING`;
    if (!written) return 0;
    const ticket = await tx.ticket.findUniqueOrThrow({
      where: { id: one.ticketId },
      select: { id: true, number: true, priority: true, technicianId: true },
    });
    await this.notices.sendBare(
      tx,
      [ticket.technicianId, ...(await this.notices.dispatchers(tx))],
      kindOf(ticket.priority),
      ticket,
      { clock: one.clock },
    );
    return 1;
  }
}

const kindOf = (p: TicketPriority) =>
  p === 'emergency' ? 'ticket.sla_at_risk_emergency' : 'ticket.sla_at_risk';
