import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DecisionAppeal } from '@prisma/client';
import {
  BoardMatters,
  type AppealRefusal,
} from '../../core/board-matters/board-matters';
import {
  DecisionAppeals,
  type DecisionAppealKind,
} from '../../core/decision-appeals/decision-appeals';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { decisionAppealReference } from './appeal-rules';

/**
 * A decision appeal the management upheld, taken to the board (ADR 0059's
 * `management_appeal`, on ADR 0055), registered with core's BoardMatters.
 * Its row locked for update, as every write to an appeal takes it; it is
 * marked while the board has it, and the decision's domain marks its
 * subject again (a permit's purge waits).
 *
 * The board's overturn applies the same domain effect, through the same
 * checks, with no manager deciding: what needs one (a vehicle's sticker, a
 * worker's review) and what a check refuses is left to the management.
 */
@Injectable()
export class DecisionAppealBoardAppeals implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly registry: DecisionAppeals,
  ) {}

  onModuleInit(): void {
    this.matters.registerAppeal('management_appeal', {
      resolve: async (tx, id) => {
        const a = await this.lock(tx, id);
        if (!a) return null;
        return {
          unitId: a.unitId,
          decidedAt: a.status === 'upheld' ? a.decidedAt : null,
          refused: refusal(a),
        };
      },
      lodged: async (tx, id, now) => {
        const a = await tx.decisionAppeal.update({
          where: { id },
          data: { boardAppealAt: now },
        });
        await this.registry
          .handler(a.kind as DecisionAppealKind)
          ?.lodged(tx, a.subjectId, now);
      },
      closed: async (tx, id, outcome, now) => {
        const a = await this.lock(tx, id);
        if (!a?.boardAppealAt || a.boardAppealClosedAt)
          return { effect: 'none' };
        await tx.decisionAppeal.update({
          where: { id },
          data: { boardAppealClosedAt: now },
        });
        const handler = this.registry.handler(a.kind as DecisionAppealKind);
        if (!handler)
          return { effect: outcome === 'overturned' ? 'follow_up' : 'none' };
        const done = await handler.closed(tx, a.subjectId, outcome, {
          now,
          decidedById: null,
          decisionAt: a.decisionAt,
          appealId: a.id,
        });
        return {
          effect:
            outcome !== 'overturned'
              ? 'none'
              : done.effect === 'applied'
                ? 'applied'
                : 'follow_up',
        };
      },
      describe: async (tx, id) => {
        const a = await tx.decisionAppeal.findUnique({ where: { id } });
        if (!a) return null;
        const handler = this.registry.handler(a.kind as DecisionAppealKind);
        return {
          reference: decisionAppealReference(a.number),
          kind: a.kind,
          status: a.status,
          decidedAt: a.decidedAt,
          rationale: a.rationale,
          deciderRoleKey: a.deciderRoleKey,
          subject: handler ? await handler.describe(tx, a.subjectId) : null,
        };
      },
    });
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<DecisionAppeal | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM decision_appeals WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.decisionAppeal.findUniqueOrThrow({ where: { id } });
  }
}

/** Why a decision appeal may not go to the board now, or null. */
function refusal(a: DecisionAppeal): AppealRefusal | null {
  if (a.boardAppealAt) return 'appealed';
  if (a.status === 'pending') return 'not_decided';
  if (a.status !== 'upheld') return 'not_in_force';
  return null;
}
