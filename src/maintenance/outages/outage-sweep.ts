import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { OutagesService } from './outages.service';

export const OUTAGE_SWEEP = 'maintenance.outage_notices';
/** A planned outage is told 48 hours ahead: a look every five minutes is on time. */
export const OUTAGE_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Tells the residents of a planned outage OUTAGE_NOTICE_HOURS before it
 * starts (ADR 0066): each outage in a transaction of its own, FOR UPDATE
 * SKIP LOCKED, deciding by what it reads after the lock, so two runs tell
 * each resident once.
 */
@Injectable()
export class OutageSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly outages: OutagesService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(OUTAGE_SWEEP, (now) => this.run(now), {
      intervalMs: OUTAGE_SWEEP_INTERVAL_MS,
    });
  }

  /** Outages told across the compounds. */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      (tx) => this.outages.dueIds(tx, now),
      async (tx, _tenantId, id) =>
        (await this.outages.announceDue(tx, id, now)) ? 1 : 0,
    );
  }
}
