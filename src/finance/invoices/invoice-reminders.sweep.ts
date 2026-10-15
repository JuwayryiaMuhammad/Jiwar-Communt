import { Injectable, type OnModuleInit } from '@nestjs/common';
import { addDays } from '../../core/common/slots/day-slots';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { localToday } from '../db-clock';
import { CREDITED_SQL, PAID_SQL } from './balances';
import { FinanceNotices } from '../notices/finance-notices';

export const INVOICE_REMINDERS_SWEEP = 'finance.reminders';
/** An invoice still owed is announced this many days before it falls due. */
export const DUE_SOON_DAYS = 3;
const BATCH = 500;

/**
 * The reminders of an invoice still owed (ADR 0046), from the compound's
 * day: `due_soon` once, three days before its due date (or later, if the
 * sweep missed that day, until it falls due), and `overdue` once, the day
 * after. No late fee. "Once" is the invoice's notice row, claimed before
 * the notification is written; an invoice paid or credited meanwhile is
 * told nothing.
 */
@Injectable()
export class InvoiceRemindersSweep implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly tenantSettings: TenantSettingsService,
    private readonly notices: FinanceNotices,
  ) {}

  onModuleInit(): void {
    this.sweep.register(INVOICE_REMINDERS_SWEEP, () => this.run());
  }

  /** Reminders sent. */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true },
        });
        if (tenant?.status !== 'active') return [];
        const settings = await this.tenantSettings.inTx(tx, tenantId);
        const today = await localToday(tx, settings.timezone);
        const soon = addDays(today, DUE_SOON_DAYS);
        return tx.$queryRaw<
          { id: string; unitId: string; kind: 'due_soon' | 'overdue' }[]
        >`
          SELECT i.id, i.unit_id AS "unitId",
                 CASE WHEN i.due_on < ${today}::date THEN 'overdue' ELSE 'due_soon' END AS kind
            FROM invoices i
           WHERE i.due_on <= ${soon}::date
             AND i.total - ${CREDITED_SQL} - ${PAID_SQL} > 0
             AND NOT EXISTS (
               SELECT 1 FROM invoice_notices n
                WHERE n.tenant_id = i.tenant_id AND n.invoice_id = i.id
                  AND n.kind = CASE WHEN i.due_on < ${today}::date THEN 'overdue' ELSE 'due_soon' END)
           ORDER BY i.due_on, i.number LIMIT ${BATCH}`;
      },
      async (tx, tenantId, item) => {
        // Still owed under the claim: a payment in between tells nothing.
        const [{ owed }] = await tx.$queryRaw<{ owed: boolean }[]>`
          SELECT (i.total - ${CREDITED_SQL} - ${PAID_SQL}) > 0 AS owed
            FROM invoices i WHERE i.id = ${item.id}::uuid`;
        if (!owed) return 0;
        return (await this.notices.invoiceNotice(tx, tenantId, item, item.kind))
          ? 1
          : 0;
      },
    );
  }
}
