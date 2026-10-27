import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { InspectionsService } from './inspections.service';

export const INSPECTION_SWEEP = 'maintenance.inspections';
export const INSPECTION_SWEEP_INTERVAL_MS = 15 * 60_000;
export const INSPECTION_BATCH = 200;

/**
 * The inspections' time-driven work (ADR 0064), every compound, each item
 * in a transaction of its own: a round whose next date is within its lead
 * days opens its inspection (once per round and date); an open inspection
 * past its day is told of once.
 */
@Injectable()
export class InspectionSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly inspections: InspectionsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(INSPECTION_SWEEP, () => this.run(), {
      intervalMs: INSPECTION_SWEEP_INTERVAL_MS,
    });
  }

  async run(): Promise<number> {
    const opened = await this.sweep.forEachTenantItem(
      (tx, tenantId) =>
        this.inspections.dueRounds(tx, tenantId, INSPECTION_BATCH),
      async (tx, tenantId, id) =>
        (await this.inspections.openRound(tx, tenantId, id)) ? 1 : 0,
    );
    return (
      opened +
      (await this.sweep.forEachTenantItem(
        (tx, tenantId) =>
          this.inspections.overdueOnes(tx, tenantId, INSPECTION_BATCH),
        (tx, tenantId, id) => this.inspections.alertOverdue(tx, tenantId, id),
      ))
    );
  }
}
