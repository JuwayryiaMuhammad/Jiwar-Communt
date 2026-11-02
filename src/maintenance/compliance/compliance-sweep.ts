import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { ComplianceService } from './compliance.service';

export const COMPLIANCE_SWEEP = 'maintenance.compliance';
/** Due days fall on a day: an hourly look is soon enough. */
export const COMPLIANCE_SWEEP_INTERVAL_MS = 60 * 60_000;
export const COMPLIANCE_BATCH = 200;

/**
 * Compliance's time-driven work (ADR 0087), every compound, each due day
 * in a transaction of its own: a due day within one of its lead times is
 * told once per lead time (never a longer one after a shorter), a passed
 * one once; to its responsible staff member and who keeps the calendar
 * (`compliance.manage`). A lapse blocks nothing: the calendar shows it red.
 */
@Injectable()
export class ComplianceSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly compliance: ComplianceService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(COMPLIANCE_SWEEP, () => this.run(), {
      intervalMs: COMPLIANCE_SWEEP_INTERVAL_MS,
    });
  }

  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      (tx, tenantId) => this.compliance.dueOnes(tx, tenantId, COMPLIANCE_BATCH),
      (tx, tenantId, id) => this.compliance.alert(tx, tenantId, id),
    );
  }
}
