import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/common/cls/request-context';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  drawPurchaseOrder,
  type PurchaseOrderPdfLine,
} from '../../core/pdf/purchase-order';
import { PdfRenderer } from '../../core/pdf/pdf-renderer';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { compoundDay, ofDateColumn } from '../schedules/local-dates';
import { orderNotFound } from './order-progress';
import { orderReference } from './purchase-order-rules';

/**
 * A purchase order as a PDF for its vendor (ADR 0094), drawn on demand from
 * the revision in force and never stored. Staff read any order's; a vendor's
 * contractors only their company's, once it was sent.
 */
@Injectable()
export class PurchaseOrderDocuments {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly globalDb: GlobalDbService,
    private readonly pdf: PdfRenderer,
    private readonly calendar: CompoundCalendar,
  ) {}

  pdfOf(
    id: string,
    only?: { vendorId: string },
  ): Promise<{ name: string; body: Buffer }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const o = await tx.purchaseOrder.findFirst({
        where: only
          ? {
              id,
              vendorId: only.vendorId,
              sentAt: { not: null },
              status: { in: ['approved', 'closed'] },
            }
          : { id },
      });
      if (!o) throw orderNotFound();
      const lines = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: id },
        orderBy: { position: 'asc' },
      });
      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: o.vendorId },
        select: { name: true, legalName: true, taxNumber: true },
      });
      const { name: compound } = await this.globalDb
        .in(tx)
        .tenant.findUniqueOrThrow({
          where: { id: this.ctx.txTenantId },
          select: { name: true },
        });
      const { timeZone } = await this.calendar.now(tx);
      const number = orderReference(o.number);
      const rows: PurchaseOrderPdfLine[] = lines.map((l) => ({
        position: String(l.position),
        description: l.description,
        quantity: `${l.quantity.toString()} ${l.unit}`,
        unitPrice: l.unitPrice.toFixed(2),
        vat: l.taxRate.gt(0) ? `${l.taxRate.toString()}%` : '-',
        net: l.net.toFixed(2),
      }));
      const body = await this.pdf.render(
        { title: `${number}-${o.revision}`, createdAt: o.raisedAt },
        (page) =>
          drawPurchaseOrder(page, {
            template: 'purchase-order.v1',
            compound,
            number,
            revision: o.revision,
            vendorName: vendor.legalName ?? vendor.name,
            vendorTaxNumber: vendor.taxNumber,
            deliveryOn: ofDateColumn(o.deliveryOn),
            issuedOn: compoundDay(
              o.sentAt ?? o.decidedAt ?? o.raisedAt,
              timeZone,
            ),
            lines: rows,
            subtotal: o.subtotal.toFixed(2),
            tax: o.tax.toFixed(2),
            total: o.total.toFixed(2),
            note: o.note,
          }),
      );
      return { name: `${number}-r${o.revision}.pdf`, body };
    });
  }
}
