import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { SpaceUsesService } from './space-uses.service';

export const SPACE_USE_EXPIRY_SWEEP = 'facilities.space_uses_expire';
const BATCH = 500;

/**
 * A common-area use request nobody decided by its start expires (ADR
 * 0084), and its requester is told. Every five minutes; one request per
 * transaction, claimed with a conditional update.
 */
@Injectable()
export class SpaceUseSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly uses: SpaceUsesService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(SPACE_USE_EXPIRY_SWEEP, (now) => this.expire(now), {
      intervalMs: 5 * 60_000,
    });
  }

  /** Requests expired. */
  expire(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const due = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM space_use_requests
           WHERE status = 'pending' AND starts_at <= ${now}
           ORDER BY starts_at, id LIMIT ${BATCH}`;
        return due.map((r) => r.id);
      },
      (tx, _tenantId, id) => this.uses.expireIn(tx, id, now),
    );
  }
}
