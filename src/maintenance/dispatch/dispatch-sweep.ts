import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { DispatchEngine } from './dispatch-engine';
import { DispatchSettingsService } from './dispatch-settings.service';
import { TechnicianQualification } from './technician-qualification';

export const DISPATCH_SWEEP = 'maintenance.dispatch';

/** Queued tickets one sweep run tries per compound. */
export const SWEEP_BATCH = 100;

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
 */
@Injectable()
export class DispatchSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly engine: DispatchEngine,
    private readonly settings: DispatchSettingsService,
    private readonly qualification: TechnicianQualification,
  ) {}

  onModuleInit(): void {
    this.sweep.register(DISPATCH_SWEEP, () => this.run());
  }

  /** Tickets assigned across the compounds. */
  run(): Promise<number> {
    return this.sweep.forEachTenant(async (tx, tenantId) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true },
      });
      if (tenant?.status !== 'active') return 0;
      await this.engine.serialize(tx);
      // Whatever the setting: a technician who can no longer work must not
      // keep tickets (ADR 0033). The engine retries what that releases.
      await this.qualification.reconcile(tx);
      if (!(await this.settings.inTx(tx)).autoDispatchEnabled) return 0;
      const queue = await tx.$queryRaw<{ id: string }[]>`
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
         LIMIT ${SWEEP_BATCH}`;
      let assigned = 0;
      for (const { id } of queue)
        if (
          (await this.engine.attempt(tx, id, 'sweep'))?.outcome === 'assigned'
        )
          assigned++;
      return assigned;
    });
  }
}
