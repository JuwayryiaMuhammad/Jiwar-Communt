import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { PermitCore } from './permit-core';

export const NOT_DECIDED_SWEEP = 'permits.not_decided';
const BATCH = 200;

/**
 * Pending permits nobody decided in time (ADR 0049): works, a move or a
 * material exit once its window has ended, an event once it has started.
 * Each is cancelled by the system (`not_decided`), in a transaction of its
 * own, its row locked and judged again: a decision holding the lock wins.
 * The requester is told.
 */
@Injectable()
export class PermitSweeps implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly audit: AuditService,
    private readonly core: PermitCore,
  ) {}

  onModuleInit(): void {
    this.sweep.register(NOT_DECIDED_SWEEP, (now) => this.notDecided(now));
  }

  /** Permits cancelled. */
  notDecided(now: Date): Promise<number> {
    const due = (p: { kind: string; startsAt: Date; endsAt: Date }) =>
      (p.kind === 'event' ? p.startsAt : p.endsAt).getTime() <= now.getTime();
    return this.sweep.forEachTenantItem(
      async (tx) => {
        const rows = await tx.unitPermit.findMany({
          where: {
            status: 'pending',
            OR: [
              { kind: 'event', startsAt: { lte: now } },
              { kind: { not: 'event' }, endsAt: { lte: now } },
            ],
          },
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        return rows.map((r) => r.id);
      },
      async (tx: TenantTxClient, _tenantId, id: string) => {
        await tx.$queryRaw`
          SELECT id FROM unit_permits WHERE id = ${id}::uuid FOR UPDATE`;
        const p = await tx.unitPermit.findUniqueOrThrow({ where: { id } });
        if (p.status !== 'pending' || !due(p)) return 0;
        await tx.unitPermit.update({
          where: { id },
          data: {
            status: 'cancelled',
            cancelledAt: now,
            cancelSide: 'system',
            cancelReason: 'not_decided',
          },
        });
        await this.audit.record(tx, {
          action: 'unit_permit.cancelled',
          targetId: id,
          metadata: {
            kind: p.kind,
            unitId: p.unitId,
            from: 'pending',
            side: 'system',
            reasonCode: 'not_decided',
          },
        });
        await this.core.notify(
          tx,
          [p.requestedById],
          'unit_permit.cancelled',
          id,
          { permitKind: p.kind, reason: 'not_decided' },
        );
        return 1;
      },
    );
  }
}
