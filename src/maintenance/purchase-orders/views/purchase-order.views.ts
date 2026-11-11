import { ApiProperty } from '@nestjs/swagger';
import { ofDateColumn } from '../../schedules/local-dates';
import type { ReceiptRecord } from '../goods-receipts';
import {
  CLOSE_REASONS,
  LINE_KINDS,
  ORDER_SOURCES,
  ORDER_STATUSES,
  REVISION_STATUSES,
  orderReference,
  receiptReference,
} from '../purchase-order-rules';
import type { OrderRecord } from '../purchase-orders.service';

const id = (nullable = false) =>
  ApiProperty({ type: String, format: 'uuid', nullable });
const money = (description?: string) =>
  ApiProperty({ type: String, example: '1200.00', description });
const day = (nullable = false) =>
  ApiProperty({ type: String, format: 'date', nullable });
const instant = (nullable = false) =>
  ApiProperty({ type: String, format: 'date-time', nullable });

/** An order's line, with what has happened to it. */
export class PurchaseOrderLineView {
  @id() id: string;
  @ApiProperty({ type: Number }) position: number;
  @ApiProperty({ enum: LINE_KINDS, enumName: 'PurchaseOrderLineKind' })
  kind: string;
  @id(true) stockItemId: string | null;
  @ApiProperty({ type: String }) description: string;
  @ApiProperty({ type: String, example: '10.000' }) quantity: string;
  @ApiProperty({ type: String }) unit: string;
  @money('Net of VAT, for one.') unitPrice: string;
  @ApiProperty({
    type: String,
    enum: ['zero', 'exempt', 'vat_14'],
    enumName: 'TaxCode',
  })
  taxCode: string;
  @ApiProperty({ type: String, nullable: true }) withholdingCategory:
    string | null;
  @money() net: string;
  @money() tax: string;
  @ApiProperty({ type: String, example: '0.000' }) accepted: string;
  @ApiProperty({ type: String, example: '0.000' }) rejected: string;
  @ApiProperty({
    type: String,
    example: '0.000',
    description: 'Billed on approved or paid invoices.',
  })
  invoiced: string;
}

/** One line of a revision: what was proposed. */
export class PurchaseOrderRevisionLineView {
  @id() id: string;
  @ApiProperty({ enum: LINE_KINDS, enumName: 'PurchaseOrderLineKind' })
  kind: string;
  @id(true) stockItemId: string | null;
  @ApiProperty({ type: String }) description: string;
  @ApiProperty({ type: String }) quantity: string;
  @ApiProperty({ type: String }) unit: string;
  @ApiProperty({ type: String }) unitPrice: string;
  @ApiProperty({
    type: String,
    enum: ['zero', 'exempt', 'vat_14'],
    enumName: 'TaxCode',
  })
  taxCode: string;
  @ApiProperty({ type: String, nullable: true }) withholdingCategory:
    string | null;
}

/** A revision: the raising (the first) or an amendment. */
export class PurchaseOrderRevisionView {
  @ApiProperty({ type: Number }) revision: number;
  @ApiProperty({
    enum: REVISION_STATUSES,
    enumName: 'PurchaseOrderRevisionStatus',
  })
  status: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.purchaseOrderAmend; null for the first.',
  })
  reasonCode: string | null;
  @id() budgetLineId: string;
  @day() deliveryOn: string;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: [PurchaseOrderRevisionLineView] })
  lines: PurchaseOrderRevisionLineView[];
  @money() subtotal: string;
  @money() tax: string;
  @money() total: string;
  @instant() requestedAt: Date;
  @ApiProperty({ type: Boolean, description: 'The caller asked for it.' })
  requestedByMe: boolean;
  @instant(true) decidedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.purchaseOrderReject.',
  })
  rejectReason: string | null;
  @ApiProperty({ type: String, nullable: true }) decisionNote: string | null;
  @id(true) approvalRequestId: string | null;
}

export class GoodsReceiptLineView {
  @id() purchaseOrderLineId: string;
  @ApiProperty({ type: Number }) position: number;
  @ApiProperty({ enum: LINE_KINDS, enumName: 'PurchaseOrderLineKind' })
  kind: string;
  @ApiProperty({ type: String }) description: string;
  @ApiProperty({ type: String }) unit: string;
  @ApiProperty({ type: String, example: '4.000' }) accepted: string;
  @ApiProperty({ type: String, example: '0.000' }) rejected: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.goodsRejection.',
  })
  rejectReason: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @id(true) stockMovementId: string | null;
}

export class GoodsReceiptPhotoView {
  @id() fileId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A signed read URL.',
  })
  url: string | null;
}

/** What arrived against an order, once. */
export class GoodsReceiptView {
  @id() id: string;
  @ApiProperty({ type: String, example: 'GR-000001' }) reference: string;
  @id() purchaseOrderId: string;
  @day() receivedOn: string;
  @id(true) storeId: string | null;
  @ApiProperty({ type: String, nullable: true }) deliveryNote: string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @instant() createdAt: Date;
  @ApiProperty({ type: Boolean, description: 'The caller recorded it.' })
  receivedByMe: boolean;
  @ApiProperty({ type: [GoodsReceiptLineView] }) lines: GoodsReceiptLineView[];
  @ApiProperty({ type: [GoodsReceiptPhotoView] })
  photos: GoodsReceiptPhotoView[];

  static from(r: ReceiptRecord): GoodsReceiptView {
    return {
      id: r.receipt.id,
      reference: receiptReference(r.receipt.number),
      purchaseOrderId: r.receipt.purchaseOrderId,
      receivedOn: ofDateColumn(r.receipt.receivedOn),
      storeId: r.receipt.storeId,
      deliveryNote: r.receipt.deliveryNote,
      note: r.receipt.note,
      createdAt: r.receipt.createdAt,
      receivedByMe: r.receivedByMe,
      lines: r.lines.map((l) => ({
        purchaseOrderLineId: l.line.purchaseOrderLineId,
        position: l.position,
        kind: l.kind,
        description: l.description,
        unit: l.unit,
        accepted: l.line.accepted.toFixed(3),
        rejected: l.line.rejected.toFixed(3),
        rejectReason: l.line.rejectReason,
        note: l.line.note,
        stockMovementId: l.line.stockMovementId,
      })),
      photos: r.photos.map((p) => ({ fileId: p.fileId, url: p.url })),
    };
  }
}

/** A vendor invoice naming the order. */
export class PurchaseOrderInvoiceView {
  @id() id: string;
  @ApiProperty({ type: String, example: 'VI-000001' }) reference: string;
  @ApiProperty({ type: String }) status: string;
  @money() total: string;
}

/** A purchase order (ADR 0094): the revision in force, with its history. */
export class PurchaseOrderView {
  @id() id: string;
  @ApiProperty({ type: String, example: 'PO-000001' }) reference: string;
  @id() vendorId: string;
  @ApiProperty({ type: String }) vendorName: string;
  @id() budgetLineId: string;
  @ApiProperty({ enum: ORDER_SOURCES, enumName: 'PurchaseOrderSource' })
  source: string;
  @id(true) purchaseRequestId: string | null;
  @id(true) tenderId: string | null;
  @id(true) contractId: string | null;
  @day() deliveryOn: string;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: Number, description: 'The revision in force.' })
  revision: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The revision waiting for its decision.',
  })
  pendingRevision: number | null;
  @ApiProperty({ enum: ORDER_STATUSES, enumName: 'PurchaseOrderStatus' })
  status: string;
  @money('Net of VAT.') subtotal: string;
  @money() tax: string;
  @money('Net plus VAT.') total: string;
  @money('What its commitment still keeps of the budget line.')
  committed: string;
  @id(true) approvalRequestId: string | null;
  @instant() raisedAt: Date;
  @ApiProperty({ type: Boolean, description: 'The caller raised it.' })
  raisedByMe: boolean;
  @instant(true) decidedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) decisionNote: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.purchaseOrderReject.',
  })
  rejectReason: string | null;
  @instant(true) cancelledAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.purchaseOrderCancel.',
  })
  cancelReason: string | null;
  @instant(true) closedAt: Date | null;
  @ApiProperty({
    enum: CLOSE_REASONS,
    enumName: 'PurchaseOrderCloseReason',
    nullable: true,
  })
  closeReason: string | null;
  @instant(true) sentAt: Date | null;
  @ApiProperty({ type: Number, nullable: true }) sentRevision: number | null;
  @instant(true) acknowledgedAt: Date | null;
  @ApiProperty({ type: Number, nullable: true })
  acknowledgedRevision: number | null;
  @ApiProperty({ type: [PurchaseOrderLineView] })
  lines: PurchaseOrderLineView[];
  @ApiProperty({
    type: [PurchaseOrderRevisionView],
    description: 'Newest first.',
  })
  revisions: PurchaseOrderRevisionView[];
  @ApiProperty({ type: [GoodsReceiptView], description: 'Newest first.' })
  receipts: GoodsReceiptView[];
  @ApiProperty({ type: [PurchaseOrderInvoiceView] })
  invoices: PurchaseOrderInvoiceView[];

  static from(r: OrderRecord): PurchaseOrderView {
    const o = r.order;
    return {
      id: o.id,
      reference: orderReference(o.number),
      vendorId: o.vendorId,
      vendorName: r.vendorName,
      budgetLineId: o.budgetLineId,
      source: o.source,
      purchaseRequestId: o.purchaseRequestId,
      tenderId: o.tenderId,
      contractId: o.contractId,
      deliveryOn: ofDateColumn(o.deliveryOn),
      note: o.note,
      revision: o.revision,
      pendingRevision: o.pendingRevision,
      status: o.status,
      subtotal: o.subtotal.toFixed(2),
      tax: o.tax.toFixed(2),
      total: o.total.toFixed(2),
      committed: r.committed.toFixed(2),
      approvalRequestId: o.approvalRequestId,
      raisedAt: o.raisedAt,
      raisedByMe: r.raisedByMe,
      decidedAt: o.decidedAt,
      decisionNote: o.decisionNote,
      rejectReason: o.rejectReason,
      cancelledAt: o.cancelledAt,
      cancelReason: o.cancelReason,
      closedAt: o.closedAt,
      closeReason: o.closeReason,
      sentAt: o.sentAt,
      sentRevision: o.sentRevision,
      acknowledgedAt: o.acknowledgedAt,
      acknowledgedRevision: o.acknowledgedRevision,
      lines: r.lines.map((l) => ({
        id: l.line.id,
        position: l.line.position,
        kind: l.line.kind,
        stockItemId: l.line.stockItemId,
        description: l.line.description,
        quantity: l.line.quantity.toFixed(3),
        unit: l.line.unit,
        unitPrice: l.line.unitPrice.toFixed(2),
        taxCode: l.line.taxCode,
        withholdingCategory: l.line.withholdingCategory,
        net: l.line.net.toFixed(2),
        tax: l.line.tax.toFixed(2),
        accepted: l.accepted.toFixed(3),
        rejected: l.rejected.toFixed(3),
        invoiced: l.invoiced.toFixed(3),
      })),
      revisions: r.revisions.map((v) => ({
        revision: v.revision,
        status: v.status,
        reasonCode: v.reasonCode,
        budgetLineId: v.budgetLineId,
        deliveryOn: ofDateColumn(v.deliveryOn),
        note: v.note,
        lines: (v.lines as unknown as PurchaseOrderRevisionLineView[]).map(
          (l) => ({
            id: l.id,
            kind: l.kind,
            stockItemId: l.stockItemId,
            description: l.description,
            quantity: l.quantity,
            unit: l.unit,
            unitPrice: l.unitPrice,
            taxCode: l.taxCode,
            withholdingCategory: l.withholdingCategory,
          }),
        ),
        subtotal: v.subtotal.toFixed(2),
        tax: v.tax.toFixed(2),
        total: v.total.toFixed(2),
        requestedAt: v.requestedAt,
        requestedByMe: v.requestedById === r.viewerId,
        decidedAt: v.decidedAt,
        rejectReason: v.rejectReason,
        decisionNote: v.decisionNote,
        approvalRequestId: v.approvalRequestId,
      })),
      receipts: r.receipts.map((x) => GoodsReceiptView.from(x)),
      invoices: r.invoices.map((i) => ({
        id: i.id,
        reference: `VI-${String(i.number).padStart(6, '0')}`,
        status: i.status,
        total: i.total,
      })),
    };
  }
}

/** An order as its vendor's contractors read it: what was ordered, nothing internal. */
export class ContractorPurchaseOrderLineView {
  @ApiProperty({ type: Number }) position: number;
  @ApiProperty({ type: String }) description: string;
  @ApiProperty({ type: String }) quantity: string;
  @ApiProperty({ type: String }) unit: string;
  @money() unitPrice: string;
  @ApiProperty({
    type: String,
    enum: ['zero', 'exempt', 'vat_14'],
    enumName: 'TaxCode',
  })
  taxCode: string;
  @money() net: string;
  @money() tax: string;
}

export class ContractorPurchaseOrderView {
  @id() id: string;
  @ApiProperty({ type: String, example: 'PO-000001' }) reference: string;
  @ApiProperty({ type: Number }) revision: number;
  @ApiProperty({ enum: ORDER_STATUSES, enumName: 'PurchaseOrderStatus' })
  status: string;
  @day() deliveryOn: string;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @money() subtotal: string;
  @money() tax: string;
  @money() total: string;
  @instant(true) sentAt: Date | null;
  @ApiProperty({ type: Number, nullable: true }) sentRevision: number | null;
  @instant(true) acknowledgedAt: Date | null;
  @ApiProperty({ type: Number, nullable: true })
  acknowledgedRevision: number | null;
  @ApiProperty({
    type: [ContractorPurchaseOrderLineView],
  })
  lines: ContractorPurchaseOrderLineView[];

  static from(r: OrderRecord): ContractorPurchaseOrderView {
    const o = r.order;
    return {
      id: o.id,
      reference: orderReference(o.number),
      revision: o.revision,
      status: o.status,
      deliveryOn: ofDateColumn(o.deliveryOn),
      note: o.note,
      subtotal: o.subtotal.toFixed(2),
      tax: o.tax.toFixed(2),
      total: o.total.toFixed(2),
      sentAt: o.sentAt,
      sentRevision: o.sentRevision,
      acknowledgedAt: o.acknowledgedAt,
      acknowledgedRevision: o.acknowledgedRevision,
      lines: r.lines.map((l) => ({
        position: l.line.position,
        description: l.line.description,
        quantity: l.line.quantity.toFixed(3),
        unit: l.line.unit,
        unitPrice: l.line.unitPrice.toFixed(2),
        taxCode: l.line.taxCode,
        net: l.line.net.toFixed(2),
        tax: l.line.tax.toFixed(2),
      })),
    };
  }
}
