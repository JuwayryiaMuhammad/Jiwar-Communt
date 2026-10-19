import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BookingSuspension } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import {
  BoardMatters,
  type AppealRefusal,
} from '../../core/board-matters/board-matters';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FacilitiesAccess } from '../access';
import { dbNow } from '../db-clock';

/**
 * A suspension from booking taken to the board (ADR 0055), registered with
 * core's BoardMatters. The system started it: the decision appealed is the
 * suspension itself, while in force, within 15 days of its start. Judged
 * under the unit's lock, as a booking and a lift take it. Nothing is
 * blocked meanwhile (a staff lift favours the unit); an overturn lifts it,
 * if still in force, with the system's `board_overturned`, silently.
 */
@Injectable()
export class SuspensionBoardAppeals implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly access: FacilitiesAccess,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.matters.registerAppeal('booking_suspension', {
      resolve: async (tx, id) => {
        const s = await this.lock(tx, id);
        if (!s) return null;
        const inForce = inForceAt(s, await dbNow(tx));
        const refused: AppealRefusal | null = s.boardAppealAt
          ? 'appealed'
          : !inForce
            ? 'not_in_force'
            : null;
        return { unitId: s.unitId, decidedAt: s.startsAt, refused };
      },
      lodged: async (tx, id, now) => {
        await tx.bookingSuspension.update({
          where: { id },
          data: { boardAppealAt: now },
        });
      },
      closed: async (tx, id, outcome, now) => {
        const s = await this.lock(tx, id);
        if (!s?.boardAppealAt || s.boardAppealClosedAt)
          return { effect: 'none' };
        const lift = outcome === 'overturned' && inForceAt(s, now);
        await tx.bookingSuspension.update({
          where: { id },
          data: {
            boardAppealClosedAt: now,
            ...(lift
              ? {
                  liftedAt: now,
                  liftedById: null,
                  liftReasonCode: 'board_overturned',
                }
              : {}),
          },
        });
        if (lift)
          await this.audit.record(tx, {
            action: 'booking_suspension.lifted',
            targetId: id,
            metadata: {
              unitId: s.unitId,
              reasonCode: 'board_overturned',
              side: 'board',
            },
          });
        // Over or lifted already: nothing is left to apply.
        return { effect: lift ? 'applied' : 'none' };
      },
      describe: async (tx, id) => {
        const s = await tx.bookingSuspension.findUnique({ where: { id } });
        if (!s) return null;
        return {
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          noShowCount: s.noShowCount,
          liftedAt: s.liftedAt,
          liftReasonCode: s.liftReasonCode,
        };
      },
    });
  }

  /** The suspension under its unit's lock, read again. */
  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<BookingSuspension | null> {
    const seen = await tx.bookingSuspension.findUnique({ where: { id } });
    if (!seen) return null;
    await this.access.lockUnit(tx, seen.unitId);
    return tx.bookingSuspension.findUniqueOrThrow({ where: { id } });
  }
}

const inForceAt = (s: BookingSuspension, now: Date) =>
  s.liftedAt === null && s.endsAt.getTime() > now.getTime();
