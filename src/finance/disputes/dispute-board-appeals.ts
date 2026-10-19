import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { InvoiceDispute } from '@prisma/client';
import {
  BoardMatters,
  type AppealRefusal,
} from '../../core/board-matters/board-matters';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FinanceAccess } from '../access';
import { formatNumber } from '../counters';
import { show } from '../money';

/**
 * A rejected invoice dispute taken to the board (ADR 0055), registered
 * with core's BoardMatters. The dispute is locked as finance locks it (the
 * compound shared, the unit, then its row) and marked while the appeal
 * runs. An overturn does nothing here by itself: the management follows it
 * up (a credit note of its own), so `follow_up`.
 */
@Injectable()
export class DisputeBoardAppeals implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly access: FinanceAccess,
  ) {}

  onModuleInit(): void {
    this.matters.registerAppeal('invoice_dispute', {
      resolve: async (tx, id) => {
        const d = await this.lock(tx, id);
        if (!d) return null;
        const refused: AppealRefusal | null = d.boardAppealAt
          ? 'appealed'
          : d.status === 'open'
            ? 'not_decided'
            : d.status === 'accepted'
              ? 'not_against_unit'
              : null;
        return { unitId: d.unitId, decidedAt: d.decidedAt, refused };
      },
      lodged: async (tx, id, now) => {
        await tx.invoiceDispute.update({
          where: { id },
          data: { boardAppealAt: now },
        });
      },
      closed: async (tx, id, outcome, now) => {
        const d = await this.lock(tx, id);
        if (d && d.boardAppealAt && !d.boardAppealClosedAt)
          await tx.invoiceDispute.update({
            where: { id },
            data: { boardAppealClosedAt: now },
          });
        return { effect: outcome === 'overturned' ? 'follow_up' : 'none' };
      },
      describe: async (tx, id) => {
        const d = await tx.invoiceDispute.findUnique({ where: { id } });
        if (!d) return null;
        const invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: d.invoiceId },
          select: { number: true, total: true },
        });
        return {
          invoiceNumber: formatNumber('invoice', invoice.number),
          invoiceTotal: show(invoice.total),
          reasonCode: d.reasonCode,
          status: d.status,
          decisionReasonCode: d.decisionReasonCode,
          decidedAt: d.decidedAt,
        };
      },
    });
  }

  /** The dispute as finance locks it: the unit's lock, then the row. */
  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<InvoiceDispute | null> {
    const seen = await tx.invoiceDispute.findUnique({ where: { id } });
    if (!seen) return null;
    await this.access.lockUnits(tx, [seen.unitId]);
    await tx.$queryRaw`
      SELECT id FROM invoice_disputes WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.invoiceDispute.findUniqueOrThrow({ where: { id } });
  }
}
