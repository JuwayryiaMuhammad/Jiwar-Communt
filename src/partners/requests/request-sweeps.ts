import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { PartnersAccess } from '../access';
import { dbNow } from '../db-clock';
import { PartnersService } from '../setup/partners.service';
import { PartnerRequestEngine } from './request-engine';
import {
  decide,
  LAPSE_AFTER_MS,
  type PartnerRequestStatus,
} from './request-rules';

export const PARTNER_EXPIRE_SWEEP = 'partners.expire_requests';
export const PARTNER_LAPSE_SWEEP = 'partners.lapse_requests';
const BATCH = 500;

/**
 * The partners' sweeps (ADR 0060), one request per transaction, each judged
 * again under the same locks as any other move (the requester's account,
 * the partner's row, the request's row) on the database's clock: an accept
 * or a done that won stays.
 *
 * - `partners.expire_requests` (every minute): a request nobody accepted
 *   whose window started (the proposed one while proposed) expires; the
 *   requester is told.
 * - `partners.lapse_requests` (hourly): an accepted request nobody closed
 *   lapses a week after its window ended; nobody is told.
 */
@Injectable()
export class PartnerRequestSweeps implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly engine: PartnerRequestEngine,
  ) {}

  onModuleInit(): void {
    this.sweep.register(PARTNER_EXPIRE_SWEEP, (now) => this.expire(now), {
      intervalMs: 60_000,
    });
    this.sweep.register(PARTNER_LAPSE_SWEEP, (now) => this.lapse(now), {
      intervalMs: 3_600_000,
    });
  }

  expire(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        if (!(await active(tx, tenantId))) return [];
        return tx.partnerRequest.findMany({
          where: {
            OR: [
              { status: 'pending', askedStartsAt: { lte: now } },
              { status: 'proposed', proposedStartsAt: { lte: now } },
            ],
          },
          select: { id: true, partnerId: true, requesterId: true },
          orderBy: [{ askedStartsAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
      },
      (tx, _tenantId, due) => this.one(tx, due, 'expire'),
    );
  }

  lapse(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        if (!(await active(tx, tenantId))) return [];
        return tx.partnerRequest.findMany({
          where: {
            status: 'accepted',
            agreedEndsAt: { lte: new Date(now.getTime() - LAPSE_AFTER_MS) },
          },
          select: { id: true, partnerId: true, requesterId: true },
          orderBy: [{ agreedEndsAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
      },
      (tx, _tenantId, due) => this.one(tx, due, 'lapse'),
    );
  }

  private async one(
    tx: TenantTxClient,
    due: { id: string; partnerId: string; requesterId: string },
    action: 'expire' | 'lapse',
  ): Promise<number> {
    await this.access.lockAccount(tx, due.requesterId);
    await this.partners.lock(tx, due.partnerId, 'share');
    const request = await this.engine.lock(tx, due.id);
    const now = await dbNow(tx);
    const verdict = decide(
      action,
      {
        status: request.status as PartnerRequestStatus,
        askedStartsAt: request.askedStartsAt,
        proposedStartsAt: request.proposedStartsAt,
        agreedStartsAt: request.agreedStartsAt,
        agreedEndsAt: request.agreedEndsAt,
      },
      now,
    );
    if (!verdict.ok) return 0;
    await this.engine.apply(tx, request, action, { kind: 'system' }, {}, now);
    return 1;
  }
}

async function active(tx: TenantTxClient, tenantId: string): Promise<boolean> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  return tenant?.status === 'active';
}
