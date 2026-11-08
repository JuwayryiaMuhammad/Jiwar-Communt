import { Injectable, type OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  PayablesBridge,
  type CommitmentItem,
} from '../../core/payables/payables-bridge';
import { dbNow } from '../db-clock';
import { dateColumn, ofDateColumn } from '../schedules/local-dates';

/**
 * Maintenance's side of payables (ADR 0089), registered with core's
 * PayablesBridge: a contract, a line of its payment schedule and a purchase
 * request, each read under its row lock (update) in finance's transaction,
 * and a schedule payment paid through the app. Finance imports no domain.
 */
@Injectable()
export class PayableSources implements OnModuleInit {
  constructor(
    private readonly bridge: PayablesBridge,
    private readonly ctx: RequestContext,
  ) {}

  onModuleInit(): void {
    this.bridge.registerSources({
      contract: async (tx, id) => {
        await tx.$queryRaw`SELECT id FROM maintenance_contracts WHERE id = ${id}::uuid FOR UPDATE`;
        const c = await tx.maintenanceContract.findUnique({ where: { id } });
        if (!c) return null;
        return {
          id: c.id,
          code: c.code,
          vendorId: c.vendorId,
          budgetLineId: c.budgetLineId,
          approvalRequestId: c.approvalRequestId,
          annualValue: c.annualValue?.toFixed(2) ?? null,
          retentionPct: c.retentionPct?.toFixed(2) ?? null,
          startsOn: ofDateColumn(c.startsOn),
          endsOn: ofDateColumn(c.endsOn),
          terminated: c.terminatedAt !== null,
        };
      },
      payment: async (tx, id) => {
        await tx.$queryRaw`SELECT id FROM maintenance_contract_payments WHERE id = ${id}::uuid FOR UPDATE`;
        const p = await tx.maintenanceContractPayment.findUnique({
          where: { id },
        });
        if (!p) return null;
        return {
          id: p.id,
          contractId: p.contractId,
          dueOn: ofDateColumn(p.dueOn),
          amount: p.amount.toFixed(2),
          paid: p.paidAt !== null,
        };
      },
      purchase: async (tx, id) => {
        await tx.$queryRaw`SELECT id FROM purchase_requests WHERE id = ${id}::uuid FOR UPDATE`;
        const r = await tx.purchaseRequest.findUnique({ where: { id } });
        if (!r) return null;
        return {
          id: r.id,
          number: r.number,
          status: r.status,
          vendorId: r.vendorId,
          budgetLineId: r.budgetLineId,
          estimatedAmount: r.estimatedAmount.toFixed(2),
          approvalRequestId: r.approvalRequestId,
        };
      },
      // The cash flow forecast's reads (ADR 0091): no lock, nothing written.
      unpaid: async (tx, through) => {
        const rows = await tx.maintenanceContractPayment.findMany({
          where: {
            paidAt: null,
            dueOn: { lte: dateColumn(through) },
            contract: { terminatedAt: null },
          },
          orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
        });
        return rows.map((p) => ({
          id: p.id,
          contractId: p.contractId,
          dueOn: ofDateColumn(p.dueOn),
          amount: p.amount.toFixed(2),
        }));
      },
      terms: async (tx, ids) => {
        if (!ids.length) return [];
        const rows = await tx.maintenanceContract.findMany({
          where: { id: { in: [...ids] } },
          select: {
            id: true,
            retentionPct: true,
            endsOn: true,
            terminatedAt: true,
          },
        });
        return rows.map((c) => ({
          id: c.id,
          retentionPct: c.retentionPct?.toFixed(2) ?? null,
          endsOn: ofDateColumn(c.endsOn),
          terminated: c.terminatedAt !== null,
        }));
      },
      // The payout's payer pays it, with the payout's number.
      settlePayment: async (tx, id, paid) => {
        await tx.maintenanceContractPayment.update({
          where: { id },
          data: {
            paidOn: dateColumn(paid.paidOn),
            paidReference: paid.reference,
            paidById: this.ctx.accountId,
            paidAt: await dbNow(tx),
          },
        });
      },
    });
  }
}

/**
 * A contract's unpaid schedule as commitment items on its line (ADR 0089):
 * none without a line.
 */
export async function contractItems(
  tx: TenantTxClient,
  contract: { id: string; vendorId: string; budgetLineId: string | null },
): Promise<CommitmentItem[]> {
  if (!contract.budgetLineId) return [];
  const rows = await tx.maintenanceContractPayment.findMany({
    where: { contractId: contract.id, paidAt: null },
    orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
  });
  return rows.map((p) => ({
    itemId: p.id,
    lineId: contract.budgetLineId!,
    amount: p.amount.toFixed(2),
    dueOn: ofDateColumn(p.dueOn),
    vendorId: contract.vendorId,
  }));
}
