import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FinanceCharge } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import {
  Charges,
  type ChargeCancelReason,
  type ChargesImpl,
  type ChargeSource,
  type ChargeState,
  type NewCharge,
  type OfficeCharge,
} from '../../core/charges/charges';
import { RequestContext } from '../../core/common/cls/request-context';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FinanceAccess } from '../access';
import { formatNumber } from '../counters';
import { dbNow } from '../db-clock';
import { show, ZERO } from '../money';
import { supersedeLive } from '../online/supersede';
import { allocateUnit } from '../payments/allocation';
import { PaymentsService } from '../payments/payments.service';
import { balancesOf } from '../invoices/balances';
import { creditInvoice, InvoicesService } from '../invoices/invoices.service';
import { ChargeSettler } from './charge-settler';

const stateOf = (c: FinanceCharge): ChargeState => ({
  id: c.id,
  invoiceId: c.invoiceId,
  amount: c.amount,
  status: c.cancelledAt ? 'cancelled' : c.paidAt ? 'paid' : 'open',
});

/**
 * Finance's side of the charges port (ADR 0070). A charge is an invoice of
 * one unit, of its source's kind, with one line, issued through the staff's
 * own path (its number, the unit told, its credit poured in at once); a
 * cancel is a credit note of what the invoice could still take, reason
 * `charge_cancelled`, by whoever cancelled the source (nobody, for the
 * system): unpaid, it owes nothing more; paid, the money goes to the unit's
 * credit and pays its other open invoices. Every write holds the unit's
 * finance lock first, then the charge's row.
 */
@Injectable()
export class FinanceChargesService implements ChargesImpl, OnModuleInit {
  constructor(
    private readonly charges: Charges,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: FinanceAccess,
    private readonly community: CommunityFinancePort,
    private readonly invoices: InvoicesService,
    private readonly settler: ChargeSettler,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.charges.implement(this);
  }

  lockUnit(tx: TenantTxClient, unitId: string): Promise<void> {
    return this.access.lockUnits(tx, [unitId]);
  }

  async raise(tx: TenantTxClient, c: NewCharge): Promise<ChargeState> {
    await this.access.lockUnits(tx, [c.unitId]);
    const units = await this.community.unitsFor(tx, { unitId: c.unitId });
    if (!units.length) throw new Error('Charges: no such unit');
    const today = await this.invoices.today(tx);
    const batchId = newId();
    await this.invoices.issueTo(tx, {
      batchId,
      target: { unitId: c.unitId },
      units,
      kind: c.kind,
      issuedOn: today,
      dueOn: c.dueOn < today ? today : c.dueOn,
      lines: [
        { descriptionEn: c.textEn, descriptionAr: c.textAr, amount: c.amount },
      ],
      createdById: this.ctx.accountIdOrNull(),
    });
    const invoice = await tx.invoice.findFirstOrThrow({
      where: { batchId },
      select: { id: true, number: true },
    });
    const charge = await tx.financeCharge.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        unitId: c.unitId,
        source: c.source,
        sourceId: c.sourceId,
        kind: c.kind,
        invoiceId: invoice.id,
        amount: c.amount,
        raisedAt: await dbNow(tx),
      },
    });
    await this.audit.record(tx, {
      action: 'finance_charge.raised',
      targetId: charge.id,
      metadata: {
        source: c.source,
        sourceId: c.sourceId,
        unitId: c.unitId,
        invoiceId: invoice.id,
        number: formatNumber('invoice', invoice.number),
        kind: c.kind,
        amount: show(c.amount),
      },
    });
    // The unit's credit may have paid it as it was issued.
    await this.settler.settle(tx, [c.unitId]);
    return stateOf(
      await tx.financeCharge.findUniqueOrThrow({ where: { id: charge.id } }),
    );
  }

  async cancel(
    tx: TenantTxClient,
    source: ChargeSource,
    sourceId: string,
    reason: ChargeCancelReason,
  ): Promise<ChargeState | null> {
    const seen = await tx.financeCharge.findFirst({
      where: { source, sourceId },
      select: { id: true, unitId: true },
    });
    if (!seen) return null;
    await this.access.lockUnits(tx, [seen.unitId]);
    await tx.$queryRaw`
      SELECT id FROM finance_charges WHERE id = ${seen.id}::uuid FOR UPDATE`;
    const charge = await tx.financeCharge.findUniqueOrThrow({
      where: { id: seen.id },
    });
    if (charge.cancelledAt) return stateOf(charge);
    const balance = (await balancesOf(tx, [charge.invoiceId])).get(
      charge.invoiceId,
    )!;
    const creditable = balance.total.sub(balance.credited);
    let creditNoteId: string | null = null;
    let released = ZERO;
    if (creditable.gt(ZERO)) {
      const credited = await creditInvoice(tx, {
        id: newId(),
        tenantId: charge.tenantId,
        invoiceId: charge.invoiceId,
        amount: creditable,
        reasonCode: 'charge_cancelled',
        createdById: this.ctx.accountIdOrNull(),
      });
      creditNoteId = credited.note.id;
      released = credited.released;
      await supersedeLive(tx, [charge.unitId]);
      // Released money pays the unit's other open invoices at once.
      if (released.gt(ZERO)) {
        await allocateUnit(tx, charge.tenantId, charge.unitId);
        await this.settler.settle(tx, [charge.unitId]);
      }
    }
    const cancelled = await tx.financeCharge.update({
      where: { id: charge.id },
      data: { cancelledAt: await dbNow(tx), cancelReason: reason },
    });
    await this.audit.record(tx, {
      action: 'finance_charge.cancelled',
      targetId: charge.id,
      metadata: {
        source,
        sourceId,
        unitId: charge.unitId,
        invoiceId: charge.invoiceId,
        reasonCode: reason,
        creditNoteId,
        credited: show(creditable.gt(ZERO) ? creditable : ZERO),
        released: show(released),
      },
    });
    return stateOf(cancelled);
  }

  /**
   * The office takes a charge's whole amount (a fine's, ADR 0070) as an
   * office payment of the unit's that names its invoice — its receipt, the
   * unit told, the charge settled and its handler run — under the unit's
   * finance lock. Cash; recorded by the caller.
   */
  async payAtOffice(tx: TenantTxClient, p: OfficeCharge): Promise<string> {
    const charge = await tx.financeCharge.findFirst({
      where: { source: p.source, sourceId: p.sourceId },
    });
    if (!charge) throw new Error('Charges: no such charge');
    await this.access.lockUnits(tx, [charge.unitId]);
    const id = newId();
    await this.payments.create(tx, id, {
      unitId: charge.unitId,
      channel: 'office',
      method: 'cash',
      amount: p.amount,
      paidOn: p.paidOn,
      reference: null,
      recordedById: this.ctx.accountId,
      named: [charge.invoiceId],
    });
    return id;
  }

  /** Reverses such a payment, as finance's office reversal does. */
  async reverseAtOffice(
    tx: TenantTxClient,
    paymentId: string,
    reasonCode: string,
  ): Promise<void> {
    await this.payments.reverseInTx(tx, newId(), paymentId, reasonCode);
  }

  async of(
    tx: TenantTxClient,
    source: ChargeSource,
    sourceIds: readonly string[],
  ): Promise<Map<string, ChargeState>> {
    const rows = await tx.financeCharge.findMany({
      where: { source, sourceId: { in: [...new Set(sourceIds)] } },
    });
    return new Map(rows.map((c) => [c.sourceId, stateOf(c)]));
  }
}
