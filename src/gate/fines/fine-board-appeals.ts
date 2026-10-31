import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { VehicleFine } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { Charges } from '../../core/charges/charges';
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
    private readonly charges: Charges,
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
        // Its invoice paid while the board looked (ADR 0070): upheld, the
        // fine is paid; overturned, the charge is credited off below.
        const paid =
          !cancel &&
          fine.status === 'unpaid' &&
          (await this.charges.one(tx, 'vehicle_fine', id))?.status === 'paid';
        await tx.vehicleFine.update({
          where: { id },
          data: {
            boardAppealClosedAt: now,
            ...(paid ? { status: 'paid' } : {}),
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
          await this.charges.cancel(tx, 'vehicle_fine', id, 'appeal_accepted');
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

  /**
   * The fine's row, after its unit's finance lock (the charges' rule, ADR
   * 0070): an overturn credits its charge off, and a payment takes the
   * finance lock and then the fine.
   */
  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<VehicleFine | null> {
    const seen = await tx.vehicleFine.findUnique({
      where: { id },
      select: { unitId: true },
    });
    if (seen) await this.charges.lockUnit(tx, seen.unitId);
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
