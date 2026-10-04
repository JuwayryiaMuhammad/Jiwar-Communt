import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { DispatchBusyError } from './dispatch-busy';
import { DispatchEngine } from './dispatch-engine';
import { DispatchLimiter } from './dispatch-limiter';
import { DispatchSettingsService } from './dispatch-settings.service';
import { TechnicianQualification } from './technician-qualification';

export const DISPATCH_SWEEP = 'maintenance.dispatch';

/** Queued tickets one sweep run tries per compound. */
export const SWEEP_BATCH = 100;

/** Queued tickets the pass that follows enabling automatic dispatch tries. */
export const DRAIN_BATCH = 50;

/**
 * The backstop (ADR 0033): every trigger of the engine is an event, and an
 * event can be missed (a technician set available with the setting off, an
 * engine failure, a release the app crashed before retrying). The sweep
 * first releases the tickets of technicians who no longer qualify (a role
 * that lost `tickets.work` in an `access:sync`), in every compound, and then
 * tries the queue of every compound that has automatic dispatch on.
 *
 * A suspended compound is skipped: nothing is assigned and nobody is told
 * while it is locked down. Emergencies first, then the tickets tried least
 * recently (so a stuck batch never starves the rest), then the oldest. Every
 * retry is an attempt row; the dispatchers are still told once per cycle.
 *
 * **Each ticket, and each technician released, is its own transaction**: the
 * dispatch lock a decision takes is held for that decision alone, never for
 * the batch, so a resident's new ticket waits behind at most one decision.
 */
@Injectable()
export class DispatchSweep implements OnModuleInit {
  private readonly logger = new Logger(DispatchSweep.name);

  constructor(
    private readonly sweep: SweepRunner,
    private readonly engine: DispatchEngine,
    private readonly limiter: DispatchLimiter,
    private readonly settings: DispatchSettingsService,
    private readonly qualification: TechnicianQualification,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sweep.register(DISPATCH_SWEEP, () => this.run());
  }

  /** Tickets assigned across the compounds. */
  async run(): Promise<number> {
    // First, whatever the setting: a technician who can no longer work must
    // not keep tickets (ADR 0033). What that releases is in the queue below.
    await this.sweep.forEachTenantItem(
      async (tx, tenantId) =>
        (await this.active(tx, tenantId))
          ? this.qualification.unqualifiedHolders(tx)
          : [],
      (tx, _tenantId, technicianId) =>
        this.qualification.reconcileOne(tx, technicianId),
    );
    // Then the queue of every compound with automatic dispatch on.
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        if (!(await this.active(tx, tenantId))) return [];
        if (!(await this.settings.inTx(tx)).autoDispatchEnabled) return [];
        return this.queue(tx, SWEEP_BATCH);
      },
      (tx, tenantId, ticketId) => this.decide(tx, tenantId, ticketId, 'sweep'),
    );
  }

  /**
   * Turning automatic dispatch on: a bounded pass over this compound's queue
   * (the request's), so enabling has an effect now, not at the next sweep.
   * Each ticket is decided in a transaction of its own.
   */
  async drain(): Promise<number> {
    const ids = await this.tenantTx.withTenantTx((tx) =>
      this.queue(tx, DRAIN_BATCH),
    );
    return this.engine.dispatch(ids, 'enabled');
  }

  private async active(tx: TenantTxClient, tenantId: string): Promise<boolean> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return tenant?.status === 'active';
  }

  /** One decision; a busy lock is skipped, not waited out for every ticket. */
  private async decide(
    tx: TenantTxClient,
    tenantId: string,
    ticketId: string,
    trigger: 'sweep',
  ): Promise<number> {
    if (this.limiter.isBusy(tenantId)) return 0;
    try {
      return (await this.engine.run(tx, ticketId, trigger)).outcome ===
        'assigned'
        ? 1
        : 0;
    } catch (error) {
      if (!(error instanceof DispatchBusyError)) throw error;
      this.limiter.markBusy(tenantId);
      this.logger.warn('dispatch lock busy: the rest of the queue waits');
      return 0;
    }
  }

  /** The queue, most urgent first, tickets tried longest ago first. */
  private queue(tx: TenantTxClient, limit: number): Promise<string[]> {
    return tx.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM tickets t
          LEFT JOIN LATERAL (
            SELECT max(a.created_at) AS last
              FROM ticket_dispatch_attempts a
             WHERE a.tenant_id = t.tenant_id AND a.ticket_id = t.id
               AND a.cycle = t.cycle) tried ON true
         WHERE t.status = 'new' AND t.technician_account_id IS NULL
         ORDER BY CASE t.priority
                    WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
                  tried.last ASC NULLS FIRST, t.created_at, t.id
         LIMIT ${limit}`.then((rows) => rows.map((r) => r.id));
  }
}
