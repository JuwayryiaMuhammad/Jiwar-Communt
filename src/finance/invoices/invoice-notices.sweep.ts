import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { FinanceNotices } from '../notices/finance-notices';

export const INVOICE_NOTICES_SWEEP = 'finance.invoice_notices';
const BATCH = 500;

/**
 * Announces invoices a big issue left to it (ADR 0046): every minute, the
 * invoices of active compounds nobody was told about yet, one per
 * transaction. "Once" is the invoice's `issued` notice row, claimed before
 * the notification is written, so the issue and the sweep never both tell.
 */
@Injectable()
export class InvoiceNoticesSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly notices: FinanceNotices,
  ) {}

  onModuleInit(): void {
    this.sweep.register(INVOICE_NOTICES_SWEEP, () => this.run(), {
      intervalMs: 60_000,
    });
  }

  /** Invoices announced. */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true },
        });
        if (tenant?.status !== 'active') return [];
        return tx.$queryRaw<{ id: string; unitId: string }[]>`
          SELECT i.id, i.unit_id AS "unitId" FROM invoices i
           WHERE NOT EXISTS (
             SELECT 1 FROM invoice_notices n
              WHERE n.tenant_id = i.tenant_id AND n.invoice_id = i.id
                AND n.kind = 'issued')
           ORDER BY i.created_at, i.id LIMIT ${BATCH}`;
      },
      async (tx, tenantId, invoice) =>
        (await this.notices.invoiceNotice(tx, tenantId, invoice, 'issued'))
          ? 1
          : 0,
    );
  }
}
