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
 * runs each source's paid handler once per settlement (ADR 0070); clears
 * the stamp of one a reversed office payment left owed again, and runs the
 * source's unpaid handler. Called after every allocation — a payment, a
 * reversal, the unit's credit poured into a new invoice, a release after a
 * credit note — in that transaction, under the units' finance locks its
 * caller holds. A charge credited off is never paid: its invoice owes
 * nothing because of the credit note, not a payment.
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
    const live = await tx.financeCharge.findMany({
      where: { unitId: { in: [...new Set(unitIds)] }, cancelledAt: null },
      orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
    });
    if (!live.length) return 0;
    const balances = await balancesOf(
      tx,
      live.map((c) => c.invoiceId),
    );
    let n = 0;
    for (const c of live) {
      const b = balances.get(c.invoiceId)!;
      const settled = b.outstanding.lte(ZERO) && b.paid.gt(ZERO);
      if (settled && !c.paidAt) await this.paid(tx, c, await dbNow(tx));
      // A reversed office payment left a paid one owed again.
      else if (!settled && c.paidAt && b.outstanding.gt(ZERO))
        await this.reopened(tx, c);
      else continue;
      n++;
    }
    return n;
  }

  private async paid(
    tx: TenantTxClient,
    c: FinanceCharge,
    now: Date,
  ): Promise<void> {
    // Stamped once per settlement (the trigger never moves it): two
    // allocations of one unit run one at a time under its finance lock, and
    // the second finds it paid.
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

  private async reopened(tx: TenantTxClient, c: FinanceCharge): Promise<void> {
    await tx.financeCharge.update({
      where: { id: c.id },
      data: { paidAt: null },
    });
    await this.audit.record(tx, {
      action: 'finance_charge.reopened',
      targetId: c.id,
      metadata: {
        source: c.source,
        sourceId: c.sourceId,
        unitId: c.unitId,
        invoiceId: c.invoiceId,
      },
    });
    const handler = this.charges.unpaidHandler(c.source as ChargeSource);
    if (handler)
      await handler(tx, {
        chargeId: c.id,
        source: c.source as ChargeSource,
        sourceId: c.sourceId,
        invoiceId: c.invoiceId,
        unitId: c.unitId,
        amount: c.amount,
      });
  }
}
