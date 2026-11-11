import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type PurchaseOrder,
  type PurchaseOrderLine,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { PayablesBridge } from '../../core/payables/payables-bridge';
import { dbNow } from '../db-clock';
import { ofDateColumn } from '../schedules/local-dates';
import {
  isComplete,
  uninvoicedValue,
  type LineTaxCode,
  type OrderLineFacts,
} from './purchase-order-rules';

export const orderNotFound = () =>
  appError.notFound(
    ErrorCode.PURCHASE_ORDER_NOT_FOUND,
    'Purchase order not found',
  );

/** An order, locked for update; PURCHASE_ORDER_NOT_FOUND. */
export async function lockOrder(
  tx: TenantTxClient,
  id: string,
): Promise<PurchaseOrder> {
  await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
  const o = await tx.purchaseOrder.findUnique({ where: { id } });
  if (!o) throw orderNotFound();
  return o;
}

export interface LineProgress {
  accepted: Prisma.Decimal;
  rejected: Prisma.Decimal;
  /** Billed on approved or paid invoices. */
  invoiced: Prisma.Decimal;
}

export type LineFacts = OrderLineFacts & { line: PurchaseOrderLine };

/**
 * What has happened to an order's lines (ADR 0094): accepted and rejected on
 * receipts, billed on approved or paid invoices; and what follows from it —
 * the order closes once fully received and invoiced, and its commitment
 * gives back what no received goods hold. Shared by the orders, their
 * receipts and the invoices' hook, always under the order's lock.
 */
@Injectable()
export class OrderProgress {
  constructor(
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly payables: PayablesBridge,
  ) {}

  async progress(
    tx: TenantTxClient,
    id: string,
  ): Promise<Map<string, LineProgress>> {
    const rows = await tx.$queryRaw<
      {
        line_id: string;
        accepted: Prisma.Decimal | null;
        rejected: Prisma.Decimal | null;
        invoiced: Prisma.Decimal | null;
      }[]
    >`
      SELECT l.id AS line_id,
             (SELECT sum(r.accepted) FROM goods_receipt_lines r
               WHERE r.tenant_id = l.tenant_id AND r.purchase_order_line_id = l.id) AS accepted,
             (SELECT sum(r.rejected) FROM goods_receipt_lines r
               WHERE r.tenant_id = l.tenant_id AND r.purchase_order_line_id = l.id) AS rejected,
             (SELECT sum(il.quantity) FROM finance_vendor_invoice_lines il
                JOIN finance_vendor_invoices i
                  ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
               WHERE il.tenant_id = l.tenant_id AND il.purchase_order_line_id = l.id
                 AND i.status IN ('approved', 'paid')) AS invoiced
        FROM purchase_order_lines l
       WHERE l.purchase_order_id = ${id}::uuid`;
    return new Map(
      rows.map((r) => [
        r.line_id,
        {
          accepted: new Prisma.Decimal(r.accepted ?? 0),
          rejected: new Prisma.Decimal(r.rejected ?? 0),
          invoiced: new Prisma.Decimal(r.invoiced ?? 0),
        },
      ]),
    );
  }

  async facts(tx: TenantTxClient, id: string): Promise<LineFacts[]> {
    const lines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: id },
      orderBy: { position: 'asc' },
    });
    const progress = await this.progress(tx, id);
    return lines.map((line) => ({
      line,
      id: line.id,
      quantity: line.quantity,
      accepted: progress.get(line.id)?.accepted ?? 0,
      invoiced: progress.get(line.id)?.invoiced ?? 0,
    }));
  }

  /** The gross value of what arrived and is not invoiced yet. */
  receivedNotInvoiced(facts: readonly LineFacts[]): Prisma.Decimal {
    return facts.reduce(
      (sum, f) =>
        sum.add(
          uninvoicedValue(
            {
              quantity: f.line.quantity,
              unitPrice: f.line.unitPrice,
              taxCode: f.line.taxCode as LineTaxCode,
              invoicedQuantity: f.invoiced,
            },
            f.accepted,
          ),
        ),
      new Prisma.Decimal(0),
    );
  }

  /** Cuts the order's commitment down to `value` (none when zero). */
  async keepOnly(
    tx: TenantTxClient,
    o: PurchaseOrder,
    value: Prisma.Decimal,
    reason: 'cancelled' | 'closed',
  ): Promise<void> {
    const open = await tx.financeCommitment.findFirst({
      where: { purchaseOrderId: o.id, closedAt: null },
      select: { id: true },
    });
    if (!open) return;
    await this.payables.commitments.sync(tx, {
      source: 'purchase_order',
      sourceId: o.id,
      items: value.gt(0)
        ? [
            {
              itemId: o.id,
              lineId: o.budgetLineId,
              amount: value.toFixed(2),
              dueOn: ofDateColumn(o.deliveryOn),
              vendorId: o.vendorId,
            },
          ]
        : [],
      reason,
    });
  }

  /**
   * The order closes once fully received and invoiced, giving back what its
   * commitment still holds; a closed order whose received goods are all
   * invoiced gives back the rest.
   */
  async afterChange(tx: TenantTxClient, id: string): Promise<void> {
    const o = await tx.purchaseOrder.findUnique({ where: { id } });
    if (!o) return;
    const facts = await this.facts(tx, id);
    if (o.status === 'approved' && isComplete(facts)) {
      const now = await dbNow(tx);
      await this.keepOnly(tx, o, new Prisma.Decimal(0), 'closed');
      await tx.purchaseOrderRevision.updateMany({
        where: { purchaseOrderId: id, status: 'requested' },
        data: {
          status: 'withdrawn',
          decidedById: this.ctx.accountIdOrNull(),
          decidedAt: now,
        },
      });
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status: 'closed',
          closedAt: now,
          closeReason: 'completed',
          pendingRevision: null,
        },
      });
      await this.audit.record(tx, {
        action: 'purchase_order.closed',
        targetId: id,
        metadata: { closeReason: 'completed' },
      });
      return;
    }
    if (o.status === 'closed' && this.receivedNotInvoiced(facts).lte(0))
      await this.keepOnly(tx, o, new Prisma.Decimal(0), 'closed');
  }
}
