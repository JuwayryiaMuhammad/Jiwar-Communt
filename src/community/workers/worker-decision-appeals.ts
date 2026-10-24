import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { WorkerEngagement } from '@prisma/client';
import { AppException } from '../../core/common/errors';
import { DecisionAppeals } from '../../core/decision-appeals/decision-appeals';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { WorkersAuthority } from './workers-authority';

/**
 * A rejected worker appealed to the management (ADR 0059), registered with
 * core's DecisionAppeals. The household's employer side appeals it (ADR
 * 0037's wage readers: the unit's primary, a live `workers` delegate, and
 * whoever registered the worker while they live there).
 *
 * An approval issues a code and a card and, for a passport, needs a person
 * to confirm the birth date against the document: an overturn is always
 * left to the management to review again (`needs_review`), never approved
 * here. Only rejections decided since ADR 0059 kept their time can be
 * appealed (older ones are `not_decided`).
 */
@Injectable()
export class WorkerDecisionAppeals implements OnModuleInit {
  constructor(
    private readonly registry: DecisionAppeals,
    private readonly authority: WorkersAuthority,
  ) {}

  onModuleInit(): void {
    this.registry.register('worker_rejection', {
      resolve: async (tx, id) => {
        const e = await this.lock(tx, id);
        if (!e) return null;
        // Who may see the unit's workers at all (a landlord may not).
        try {
          await this.authority.assertVisible(tx, e.unitId);
        } catch (error) {
          if (error instanceof AppException) return null;
          throw error;
        }
        const employer = await this.authority.wageReader(tx, e.unitId);
        return {
          unitId: e.unitId,
          decidedAt: e.status === 'rejected' ? e.decidedAt : null,
          deciderId: e.reviewedById,
          mayAppeal: employer(e),
          refused: e.status !== 'rejected' ? 'not_in_force' : null,
        };
      },
      lodged: () => Promise.resolve(),
      closed: (_tx, _id, outcome) =>
        Promise.resolve(
          outcome === 'overturned'
            ? { effect: 'follow_up' as const, reason: 'needs_review' as const }
            : { effect: 'none' as const },
        ),
      describe: async (tx, id) => {
        const e = await tx.workerEngagement.findUnique({ where: { id } });
        if (!e) return null;
        return {
          status: e.status,
          capacity: e.capacity,
          rejectReason: e.rejectReason,
          decidedAt: e.decidedAt,
        };
      },
    });
  }

  /**
   * The engagement's row alone, as the gate locks it: never the unit's row
   * after the management's account locks (the community's writes lock the
   * unit and then reach for accounts). A rejection's row does not move but
   * by this lock.
   */
  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<WorkerEngagement | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM worker_engagements WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.workerEngagement.findUniqueOrThrow({ where: { id } });
  }
}
