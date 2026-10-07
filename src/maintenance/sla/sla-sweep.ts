import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { SlaClock } from '@prisma/client';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { MEASURED, SlaRecorder } from './sla-recorder';

export const SLA_SWEEP = 'maintenance.sla_breach';
/** A breach is due at a minute: the sweep runs every minute (ADR 0034). */
export const SLA_SWEEP_INTERVAL_MS = 60_000;
/** Clocks one run breaches per compound. */
export const BREACH_BATCH = 500;
/** Tickets one activation step brings in line, per compound. */
export const ACTIVATION_BATCH = 100;
/** Tickets a request's pass after turning the SLA on or off handles. */
export const PASS_BATCH = 50;
export const PASS_MAX_BATCHES = 40;

interface Due {
  ticketId: string;
  cycle: number;
  clock: SlaClock;
}

/**
 * The SLA's time-driven work (ADR 0034), each ticket in a transaction of
 * its own (its row lock held for that ticket alone, never a batch):
 *
 * - **breaches:** every minute, the running clocks past their due time, in
 *   compounds with the SLA on and not suspended, are breached at exactly
 *   their due time, once;
 * - **activation:** turning the SLA on starts the open tickets' clocks
 *   after the switch committed, in bounded batches, ticket by ticket;
 *   turning it off stops them the same way. The request starts a pass; the
 *   sweep finishes whatever a pass left (a crash, a large compound), and a
 *   ticket written in between starts its own clocks under its lock.
 */
@Injectable()
export class SlaSweep implements OnModuleInit {
  private readonly logger = new Logger(SlaSweep.name);

  constructor(
    private readonly sweep: SweepRunner,
    private readonly recorder: SlaRecorder,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sweep.register(SLA_SWEEP, (now) => this.run(now), {
      intervalMs: SLA_SWEEP_INTERVAL_MS,
    });
  }

  /** Breaches recorded across the compounds. */
  async run(now: Date): Promise<number> {
    await this.sweep.forEachTenantItem(
      async (tx, tenantId) =>
        (await this.active(tx, tenantId))
          ? this.misaligned(tx, ACTIVATION_BATCH)
          : [],
      (tx, _tenantId, ticketId) => this.recorder.reconcile(tx, ticketId),
    );
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        if (!(await this.active(tx, tenantId))) return [];
        if (!(await this.recorder.activation(tx))) return [];
        return this.due(tx, now);
      },
      (tx, _tenantId, due) => this.recorder.breachDue(tx, due, now),
    );
  }

  /**
   * After the switch changed, in the request's compound: bounded batches of
   * tickets, each in its own transaction. Not awaited by the response; what
   * it leaves, the sweep finishes. Returns how many tickets it handled.
   */
  async pass(): Promise<number> {
    let done = 0;
    for (let i = 0; i < PASS_MAX_BATCHES; i++) {
      const ids = await this.tenantTx.withTenantTx((tx) =>
        this.misaligned(tx, PASS_BATCH),
      );
      if (!ids.length) break;
      for (const id of ids)
        try {
          await this.tenantTx.withTenantTx((tx) =>
            this.recorder.reconcile(tx, id),
          );
          done++;
        } catch (error) {
          this.logger.error(
            `SLA pass failed for a ticket (${error instanceof Error ? error.name : 'Error'})`,
          );
          return done;
        }
    }
    return done;
  }

  /**
   * The tickets out of line with the switch: on, measured tickets (repairs
   * only: a preventive ticket has no clocks, ADR 0038) without a clock of
   * this activation; off, tickets with a clock still running or
   * paused.
   */
  private async misaligned(
    tx: TenantTxClient,
    limit: number,
  ): Promise<string[]> {
    const since = await this.recorder.activation(tx);
    const rows = since
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT t.id FROM tickets t
           WHERE t.status::text = ANY(${[...MEASURED]}::text[])
             AND t.kind = 'repair'
             AND NOT EXISTS (
               SELECT 1 FROM ticket_sla_clocks c
                WHERE c.tenant_id = t.tenant_id AND c.ticket_id = t.id
                  AND c.started_at >= ${since})
           ORDER BY t.id
           LIMIT ${limit}`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT DISTINCT c.ticket_id AS id FROM ticket_sla_clocks c
           WHERE c.state IN ('running', 'paused')
           ORDER BY c.ticket_id
           LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  private due(tx: TenantTxClient, now: Date): Promise<Due[]> {
    return tx.$queryRaw<Due[]>`
      SELECT ticket_id AS "ticketId", cycle, clock::text AS clock
        FROM ticket_sla_clocks
       WHERE state = 'running' AND due_at <= ${now}
       ORDER BY due_at, ticket_id
       LIMIT ${BREACH_BATCH}`;
  }

  private async active(tx: TenantTxClient, tenantId: string): Promise<boolean> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return tenant?.status === 'active';
  }
}
