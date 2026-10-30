import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { ReadinessService } from './readiness.service';

export const READINESS_SWEEP = 'maintenance.readiness';
export const READINESS_SWEEP_INTERVAL_MS = 15 * 60_000;
export const READINESS_BATCH = 200;

/**
 * Readiness's time-driven work (ADR 0067), every compound, each item in a
 * transaction of its own: an open item of an open program past its day is
 * told to its owner once.
 */
@Injectable()
export class ReadinessSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly readiness: ReadinessService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(READINESS_SWEEP, () => this.run(), {
      intervalMs: READINESS_SWEEP_INTERVAL_MS,
    });
  }

  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      (tx, tenantId) =>
        this.readiness.overdueOnes(tx, tenantId, READINESS_BATCH),
      (tx, tenantId, id) => this.readiness.alertOverdue(tx, tenantId, id),
    );
  }
}
