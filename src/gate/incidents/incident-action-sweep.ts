import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { IncidentActionsService } from './incident-actions.service';

export const INCIDENT_ACTION_SWEEP = 'gate.incident_actions';
export const INCIDENT_ACTION_SWEEP_INTERVAL_MS = 15 * 60_000;
export const INCIDENT_ACTION_BATCH = 200;

/**
 * Corrective actions' time-driven work (ADR 0087), every compound, each in
 * a transaction of its own: an open action past its day is told once to
 * its owner and the incidents' keepers.
 */
@Injectable()
export class IncidentActionSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly actions: IncidentActionsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(INCIDENT_ACTION_SWEEP, () => this.run(), {
      intervalMs: INCIDENT_ACTION_SWEEP_INTERVAL_MS,
    });
  }

  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      (tx, tenantId) =>
        this.actions.overdueOnes(tx, tenantId, INCIDENT_ACTION_BATCH),
      (tx, tenantId, id) => this.actions.alertOverdue(tx, tenantId, id),
    );
  }
}
