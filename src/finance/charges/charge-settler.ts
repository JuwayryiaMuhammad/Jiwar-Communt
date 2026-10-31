import { Injectable } from '@nestjs/common';
import type { FinanceCharge } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { Charges, type ChargeSource } from '../../core/charges/charges';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { show, ZERO } from '../money';
import { balancesOf } from '../invoices/balances';

/**
 * Stamps the units' charges whose invoices payments have just settled, and
 * runs each source's paid handler once (ADR 0070). Called after every
 * allocation — a payment, the unit's credit poured into a new invoice, a
 * release after a credit note — in that transaction, under the units'
 * finance locks its caller holds. A charge credited off is never paid: its
 * invoice owes nothing because of the credit note, not a payment.
 */
@Injectable()
export class ChargeSettler {
  constructor(
    private readonly charges: Charges,
    private readonly audit: AuditService,
  ) {}

  async settle(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<number> {
    if (!unitIds.length) return 0;
    const open = await tx.financeCharge.findMany({
      where: {
        unitId: { in: [...new Set(unitIds)] },
        paidAt: null,
        cancelledAt: null,
      },
      orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
    });
    if (!open.length) return 0;
    const balances = await balancesOf(
      tx,
      open.map((c) => c.invoiceId),
    );
    let n = 0;
    for (const c of open) {
      const b = balances.get(c.invoiceId)!;
      if (b.outstanding.gt(ZERO) || b.paid.lte(ZERO)) continue;
      await this.paid(tx, c, await dbNow(tx));
      n++;
    }
    return n;
  }

  private async paid(
    tx: TenantTxClient,
    c: FinanceCharge,
    now: Date,
  ): Promise<void> {
    // Stamped once (the trigger): two allocations of one unit run one at a
    // time under its finance lock, and the second finds it paid.
    await tx.financeCharge.update({
      where: { id: c.id },
      data: { paidAt: now },
    });
    await this.audit.record(tx, {
      action: 'finance_charge.paid',
      targetId: c.id,
      metadata: {
        source: c.source,
        sourceId: c.sourceId,
        unitId: c.unitId,
        invoiceId: c.invoiceId,
        amount: show(c.amount),
      },
    });
    const handler = this.charges.paidHandler(c.source as ChargeSource);
    if (handler)
      await handler(tx, {
        chargeId: c.id,
        source: c.source as ChargeSource,
        sourceId: c.sourceId,
        invoiceId: c.invoiceId,
        unitId: c.unitId,
        amount: c.amount,
        paidAt: now,
      });
  }
}
