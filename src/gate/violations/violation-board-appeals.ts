import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { UnitViolation } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import {
  BoardMatters,
  type AppealRefusal,
} from '../../core/board-matters/board-matters';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { safetyReference } from '../safety/safety-rules';
import { dayOf } from '../vehicles/vehicle-rules';

/**
 * A unit violation (or a warning) whose appeal the staff upheld, taken to
 * the board (ADR 0055), registered with core's BoardMatters. As a fine:
 * its row locked for update, as every write to a violation takes it; no
 * payment and no staff cancellation while the board has it
 * (VIOLATION_UNDER_APPEAL); an overturn cancels it with the system's
 * `board_overturned`, silently.
 */
@Injectable()
export class ViolationBoardAppeals implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.matters.registerAppeal('unit_violation', {
      resolve: async (tx, id) => {
        const v = await this.lock(tx, id);
        if (!v) return null;
        return {
          unitId: v.unitId,
          decidedAt: v.decidedAt,
          refused: refusal(v),
        };
      },
      lodged: async (tx, id, now) => {
        await tx.unitViolation.update({
          where: { id },
          data: { boardAppealAt: now },
        });
      },
      closed: async (tx, id, outcome, now) => {
        const v = await this.lock(tx, id);
        if (!v?.boardAppealAt || v.boardAppealClosedAt)
          return { effect: 'none' };
        const cancel = outcome === 'overturned' && v.status === 'open';
        await tx.unitViolation.update({
          where: { id },
          data: {
            boardAppealClosedAt: now,
            ...(cancel
              ? {
                  status: 'cancelled',
                  cancelReason: 'board_overturned',
                  cancelledAt: now,
                  cancelledById: null,
                }
              : {}),
          },
        });
        if (cancel)
          await this.audit.record(tx, {
            action: 'violation.cancelled',
            targetId: id,
            metadata: {
              unitId: v.unitId,
              reasonCode: 'board_overturned',
              side: 'board',
            },
          });
        return {
          effect:
            outcome !== 'overturned'
              ? 'none'
              : cancel
                ? 'applied'
                : 'follow_up',
        };
      },
      describe: async (tx, id) => {
        const v = await tx.unitViolation.findUnique({ where: { id } });
        if (!v) return null;
        return {
          reference: safetyReference('V', v.number),
          kind: v.kind,
          date: dayOf(v.occurredOn),
          amount: v.amount ? v.amount.toFixed(2) : null,
          isWarning: v.amount === null,
          status: v.status,
          appealDecision: v.appealDecision,
          decidedAt: v.decidedAt,
        };
      },
    });
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<UnitViolation | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM unit_violations WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.unitViolation.findUniqueOrThrow({ where: { id } });
  }
}

/** Why a violation may not go to the board now, or null. */
function refusal(v: UnitViolation): AppealRefusal | null {
  if (v.boardAppealAt) return 'appealed';
  if (v.status === 'paid') return 'paid';
  if (v.status === 'cancelled') return 'cancelled';
  if (v.appealDecision !== 'upheld') return 'not_decided';
  return null;
}
