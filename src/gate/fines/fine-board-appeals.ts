import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { VehicleFine } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import {
  BoardMatters,
  type AppealRefusal,
} from '../../core/board-matters/board-matters';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dayOf, reference } from '../vehicles/vehicle-rules';

/**
 * A vehicle fine whose appeal the staff upheld, taken to the board (ADR
 * 0055), registered with core's BoardMatters. The fine's row is locked for
 * update, as every write to a fine takes it, so a lodge and a payment are
 * one before the other: a paid fine is not appealed, and an appealed one
 * takes no payment until the board decides (FINE_UNDER_APPEAL). An
 * overturn cancels it with the system's `board_overturned`, silently: the
 * board's decision tells the appellant.
 */
@Injectable()
export class FineBoardAppeals implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.matters.registerAppeal('vehicle_fine', {
      resolve: async (tx, id) => {
        const fine = await this.lock(tx, id);
        if (!fine) return null;
        return {
          unitId: fine.unitId,
          decidedAt: fine.decidedAt,
          refused: refusal(fine),
        };
      },
      lodged: async (tx, id, now) => {
        await tx.vehicleFine.update({
          where: { id },
          data: { boardAppealAt: now },
        });
      },
      closed: async (tx, id, outcome, now) => {
        const fine = await this.lock(tx, id);
        if (!fine?.boardAppealAt || fine.boardAppealClosedAt)
          return { effect: 'none' };
        const cancel = outcome === 'overturned' && fine.status === 'unpaid';
        await tx.vehicleFine.update({
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
            action: 'vehicle_fine.cancelled',
            targetId: id,
            metadata: {
              unitId: fine.unitId,
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
        const fine = await tx.vehicleFine.findUnique({ where: { id } });
        if (!fine) return null;
        return {
          reference: reference('F', fine.number),
          reason: fine.reason,
          date: dayOf(fine.occurredOn),
          amount: fine.amount.toFixed(2),
          currency: fine.currency,
          status: fine.status,
          appealDecision: fine.appealDecision,
          decidedAt: fine.decidedAt,
        };
      },
    });
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<VehicleFine | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vehicle_fines WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.vehicleFine.findUniqueOrThrow({ where: { id } });
  }
}

/** Why a fine may not go to the board now, or null. */
function refusal(fine: VehicleFine): AppealRefusal | null {
  if (fine.boardAppealAt) return 'appealed';
  if (fine.status === 'paid') return 'paid';
  if (fine.status === 'cancelled') return 'cancelled';
  if (fine.appealDecision !== 'upheld') return 'not_decided';
  return null;
}
