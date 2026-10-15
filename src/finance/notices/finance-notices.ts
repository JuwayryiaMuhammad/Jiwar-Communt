import { Injectable } from '@nestjs/common';
import { CommunityFinancePort } from '../../community';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { NotificationKind } from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';

/** What an invoice's notice says, once each. */
export type InvoiceNoticeKind = 'issued' | 'due_soon' | 'overdue';

const KIND: Record<InvoiceNoticeKind, NotificationKind> = {
  issued: 'invoice.issued',
  due_soon: 'invoice.due_soon',
  overdue: 'invoice.overdue',
};

/**
 * Finance's notifications (ADR 0027, 0046), in the action's transaction:
 * category `finance`, none critical, no params — never an amount, a number,
 * a unit or a name. They reach every account that sees the unit's money
 * now (capabilities.financeView), the payer included.
 */
@Injectable()
export class FinanceNotices {
  constructor(
    private readonly notifier: Notifier,
    private readonly community: CommunityFinancePort,
  ) {}

  /** Tells the unit's finance holders; how many were told. */
  async toUnit(
    tx: TenantTxClient,
    unitId: string,
    kind: NotificationKind,
    targetId: string,
  ): Promise<number> {
    const to = await this.community.financeHolders(tx, unitId);
    if (!to.length) return 0;
    return this.notifier.notify(tx, to, { kind, params: {}, targetId });
  }

  /**
   * An invoice's notice, once: the unique (invoice, kind) row is claimed
   * first, so of two senders at once (an issue and the sweep, two sweeps)
   * one tells and the other does nothing. True when this call told.
   */
  async invoiceNotice(
    tx: TenantTxClient,
    tenantId: string,
    invoice: { id: string; unitId: string },
    kind: InvoiceNoticeKind,
  ): Promise<boolean> {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO invoice_notices (id, tenant_id, invoice_id, kind)
      VALUES (${newId()}::uuid, ${tenantId}::uuid, ${invoice.id}::uuid, ${kind})
      ON CONFLICT (tenant_id, invoice_id, kind) DO NOTHING
      RETURNING id`;
    if (!claimed.length) return false;
    await this.toUnit(tx, invoice.unitId, KIND[kind], invoice.id);
    return true;
  }

  /**
   * Claims invoices' notice of `kind` without telling anyone: an
   * instalment plan announces itself once (ADR 0048), so the minute sweep
   * must never announce its instalments one by one.
   */
  async claimSilently(
    tx: TenantTxClient,
    tenantId: string,
    invoiceIds: readonly string[],
    kind: InvoiceNoticeKind,
  ): Promise<void> {
    if (!invoiceIds.length) return;
    await tx.invoiceNotice.createMany({
      data: invoiceIds.map((invoiceId) => ({
        id: newId(),
        tenantId,
        invoiceId,
        kind,
      })),
      skipDuplicates: true,
    });
  }
}
