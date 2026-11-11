import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type FinanceInvoiceMatchOverride,
  type FinanceSettings,
  type FinanceVendorInvoice,
  type FinanceVendorInvoiceLine,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { PayablesBridge } from '../../core/payables/payables-bridge';
import { FinanceAccess } from '../access';
import { dbNow } from '../db-clock';
import { money, show } from '../money';
import { LIVE_INVOICE } from './payable-rules';
import {
  evaluateMatch,
  type MatchInvoiceLine,
  type MatchIssue,
  type MatchLineResult,
  type MatchOrderLine,
  type MatchResult,
  type MatchTolerance,
} from './match-rules';

/** The compound's match settings (ADR 0094). */
export interface MatchSettingsRead {
  /** An invoice with no contract above this needs an order; null: never. */
  poRequiredAbove: string | null;
  pricePct: string;
  quantityPct: string;
  amount: string;
}

export interface MatchSettingsInput {
  poRequiredAbove?: string | null;
  pricePct?: string;
  quantityPct?: string;
  amount?: string;
}

export type MatchStatus = 'matched' | 'blocked' | 'overridden';

/** One invoice line, beside the order's line it bills. */
export interface MatchLineRead extends MatchLineResult {
  description: string;
  invoiceQuantity: string | null;
  invoiceUnitPrice: string | null;
  amount: string;
  orderDescription: string | null;
  orderedQuantity: string | null;
  orderUnitPrice: string | null;
  acceptedQuantity: string | null;
  otherInvoicedQuantity: string | null;
}

export interface MatchRecord {
  invoiceId: string;
  orderId: string;
  orderNumber: number;
  orderStatus: string;
  status: MatchStatus;
  issues: MatchIssue[];
  lines: MatchLineRead[];
  priceVariance: string;
  tolerance: MatchSettingsRead;
  override: FinanceInvoiceMatchOverride | null;
}

export const matchBlocked = (issues: number) =>
  appError.conflict(
    ErrorCode.INVOICE_MATCH_BLOCKED,
    'The invoice does not match its order and receipts',
    { params: { issues } },
  );

const DEFAULTS: MatchSettingsRead = {
  poRequiredAbove: null,
  pricePct: '2.00',
  quantityPct: '0.00',
  amount: '100.00',
};

export function settingsOf(s: FinanceSettings | null): MatchSettingsRead {
  if (!s) return DEFAULTS;
  return {
    poRequiredAbove:
      s.poRequiredAbove === null ? null : show(s.poRequiredAbove),
    pricePct: show(s.matchPricePct),
    quantityPct: show(s.matchQuantityPct),
    amount: show(s.matchAmount),
  };
}

const toleranceOf = (s: MatchSettingsRead): MatchTolerance => ({
  pricePct: s.pricePct,
  quantityPct: s.quantityPct,
  amount: s.amount,
});

/**
 * The three-way match of a vendor's invoice against its purchase order and
 * what was accepted on receipt (ADR 0094), and the compound's tolerances.
 *
 * The match is read live from the registers — the order's lines, the
 * receipts' accepted quantities and the other invoices of the order that
 * count before this one (approved or paid, or received with a lower number)
 * — never stored: a receipt that arrives, or a corrected invoice, resolves
 * it without a step. What is stored is an override: a mismatch let through
 * by a holder of `finance.match_override` who did not record the invoice,
 * with a reason, once.
 *
 * Locks: the order (update, maintenance's, through the bridge) → the
 * invoice (update).
 */
@Injectable()
export class InvoiceMatchService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: FinanceAccess,
    private readonly audit: AuditService,
    private readonly bridge: PayablesBridge,
  ) {}

  // --------------------------------------------------------------------------
  // Settings
  // --------------------------------------------------------------------------

  settings(): Promise<MatchSettingsRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      settingsOf(await tx.financeSettings.findFirst()),
    );
  }

  async settingsIn(tx: TenantTxClient): Promise<MatchSettingsRead> {
    return settingsOf(await tx.financeSettings.findFirst());
  }

  updateSettings(input: MatchSettingsInput): Promise<MatchSettingsRead> {
    for (const field of ['pricePct', 'quantityPct'] as const)
      if (input[field] !== undefined && Number(input[field]) > 100)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid request',
          {
            fields: [
              {
                field,
                code: FieldErrorCode.INVALID_VALUE,
                params: { max: '100.00' },
              },
            ],
          },
        );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings
         WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR UPDATE`;
      const before = settingsOf(
        await tx.financeSettings.findUniqueOrThrow({
          where: { tenantId: this.ctx.txTenantId },
        }),
      );
      const after = await tx.financeSettings.update({
        where: { tenantId: this.ctx.txTenantId },
        data: {
          ...(input.poRequiredAbove !== undefined
            ? { poRequiredAbove: input.poRequiredAbove }
            : {}),
          ...(input.pricePct !== undefined
            ? { matchPricePct: input.pricePct }
            : {}),
          ...(input.quantityPct !== undefined
            ? { matchQuantityPct: input.quantityPct }
            : {}),
          ...(input.amount !== undefined ? { matchAmount: input.amount } : {}),
        },
      });
      const now = settingsOf(after);
      const changes = diffChanges(
        { ...before },
        { ...now },
        'purchase_order_settings.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'purchase_order_settings.updated',
          targetId: this.ctx.txTenantId,
          changes,
        });
      return now;
    });
  }

  // --------------------------------------------------------------------------
  // The match
  // --------------------------------------------------------------------------

  /** An invoice's match; INVOICE... not found when it names no order. */
  match(invoiceId: string): Promise<MatchRecord | null> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const invoice = await tx.financeVendorInvoice.findUnique({
        where: { id: invoiceId },
      });
      if (!invoice)
        throw appError.notFound(
          ErrorCode.VENDOR_INVOICE_NOT_FOUND,
          'Vendor invoice not found',
        );
      if (!invoice.purchaseOrderId) return null;
      return (await this.evaluateMany(tx, [invoice])).get(invoice.id) ?? null;
    });
  }

  /**
   * Refuses the approval of an invoice that does not match (and was not let
   * through): INVOICE_MATCH_BLOCKED. An invoice with no order passes.
   */
  async assertApprovable(
    tx: TenantTxClient,
    invoice: FinanceVendorInvoice,
  ): Promise<void> {
    if (!invoice.purchaseOrderId) return;
    const record = (await this.evaluateMany(tx, [invoice])).get(invoice.id);
    if (record?.status === 'blocked') throw matchBlocked(record.issues.length);
  }

  /**
   * Lets a mismatch through, once, with a reason: by a holder of
   * `finance.match_override` who did not record the invoice, while it waits
   * for its approval.
   */
  override(
    invoiceId: string,
    input: { reasonCode?: string; note?: string },
  ): Promise<MatchRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.matchOverride,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.financeVendorInvoice.findUnique({
        where: { id: invoiceId },
      });
      if (!seen)
        throw appError.notFound(
          ErrorCode.VENDOR_INVOICE_NOT_FOUND,
          'Vendor invoice not found',
        );
      if (!seen.purchaseOrderId)
        throw appError.conflict(
          ErrorCode.INVOICE_MATCH_NOT_BLOCKED,
          'This invoice has no mismatch to override',
        );
      // The order first (it is locked before the invoices), then the invoice.
      await this.bridge.source.order(tx, seen.purchaseOrderId);
      await tx.$queryRaw`
        SELECT id FROM finance_vendor_invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const invoice = await tx.financeVendorInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
      if (invoice.status !== 'received')
        throw appError.conflict(
          ErrorCode.VENDOR_INVOICE_STATE,
          'The invoice is not in a state that allows this',
          { params: { status: invoice.status } },
        );
      if (invoice.recordedById === this.ctx.accountId)
        throw appError.conflict(
          ErrorCode.MATCH_SELF_OVERRIDE,
          'You recorded this invoice: someone else overrides its match',
        );
      const record = (await this.evaluateMany(tx, [invoice])).get(invoice.id)!;
      if (record.status !== 'blocked')
        throw appError.conflict(
          ErrorCode.INVOICE_MATCH_NOT_BLOCKED,
          'This invoice has no mismatch to override',
        );
      const note = input.note?.trim() || null;
      const row = await tx.financeInvoiceMatchOverride.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          invoiceId,
          reasonCode: reason,
          note,
          issues: record.issues as unknown as Prisma.InputJsonValue,
          overriddenById: this.ctx.accountId,
          overriddenAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'vendor_invoice.match_overridden',
        targetId: invoiceId,
        metadata: {
          orderId: invoice.purchaseOrderId,
          reasonCode: reason,
          issues: record.issues.map((i) => ({
            kind: i.kind,
            position: i.position,
            quantity: i.quantity,
            amount: i.amount,
          })),
        },
        ...(note ? { changes: { note: { changed: true } } } : {}),
      });
      return { ...record, status: 'overridden', override: row };
    });
  }

  /**
   * The matches of these invoices (each naming an order), in a fixed number
   * of queries: the orders' lines, what was accepted of each, every live
   * invoice line naming them, the invoices' overrides.
   */
  async evaluateMany(
    tx: TenantTxClient,
    invoices: readonly FinanceVendorInvoice[],
  ): Promise<Map<string, MatchRecord>> {
    const named = invoices.filter((i) => i.purchaseOrderId);
    const out = new Map<string, MatchRecord>();
    if (!named.length) return out;
    const settings = await this.settingsIn(tx);
    const tolerance = toleranceOf(settings);
    const orderIds = [...new Set(named.map((i) => i.purchaseOrderId!))];
    const orders = await tx.purchaseOrder.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, number: true, status: true },
    });
    const orderLines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: { in: orderIds } },
      orderBy: { position: 'asc' },
    });
    const accepted = new Map(
      (
        await tx.goodsReceiptLine.groupBy({
          by: ['purchaseOrderLineId'],
          where: {
            purchaseOrderLineId: { in: orderLines.map((l) => l.id) },
          },
          _sum: { accepted: true },
        })
      ).map((r) => [r.purchaseOrderLineId, money(r._sum.accepted ?? 0)]),
    );
    const ownLines = await tx.financeVendorInvoiceLine.findMany({
      where: { invoiceId: { in: named.map((i) => i.id) } },
      orderBy: [{ invoiceId: 'asc' }, { position: 'asc' }],
    });
    const live = await tx.$queryRaw<
      {
        invoice_id: string;
        line_id: string;
        quantity: Prisma.Decimal;
        status: string;
        number: number;
      }[]
    >`
      SELECT il.invoice_id, il.purchase_order_line_id AS line_id, il.quantity,
             i.status, i.number
        FROM finance_vendor_invoice_lines il
        JOIN finance_vendor_invoices i
          ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
       WHERE il.purchase_order_line_id = ANY(${orderLines.map((l) => l.id)}::uuid[])
         AND il.quantity IS NOT NULL
         AND i.status = ANY(${[...LIVE_INVOICE]}::text[])`;
    const overrides = new Map(
      (
        await tx.financeInvoiceMatchOverride.findMany({
          where: { invoiceId: { in: named.map((i) => i.id) } },
        })
      ).map((o) => [o.invoiceId, o]),
    );
    const byOrder = new Map<string, typeof orderLines>();
    for (const l of orderLines)
      byOrder.set(l.purchaseOrderId, [
        ...(byOrder.get(l.purchaseOrderId) ?? []),
        l,
      ]);
    for (const invoice of named) {
      const order = orders.find((o) => o.id === invoice.purchaseOrderId);
      if (!order) continue;
      const mine = ownLines.filter((l) => l.invoiceId === invoice.id);
      const lines: MatchOrderLine[] = (byOrder.get(order.id) ?? []).map(
        (l) => ({
          id: l.id,
          position: l.position,
          description: l.description,
          ordered: l.quantity,
          unitPrice: l.unitPrice,
          accepted: accepted.get(l.id) ?? 0,
          // Billed by the other invoices that count before this one.
          otherInvoiced: live
            .filter(
              (x) =>
                x.line_id === l.id &&
                x.invoice_id !== invoice.id &&
                (x.status !== 'received' || x.number < invoice.number),
            )
            .reduce((sum, x) => sum.add(x.quantity), money(0)),
        }),
      );
      const result = evaluateMatch(tolerance, lines, mine.map(asMatchLine));
      const override = overrides.get(invoice.id) ?? null;
      out.set(invoice.id, {
        invoiceId: invoice.id,
        orderId: order.id,
        orderNumber: order.number,
        orderStatus: order.status,
        status:
          result.status === 'matched'
            ? 'matched'
            : override
              ? 'overridden'
              : 'blocked',
        issues: result.issues,
        lines: mine.map((l, i) => lineRead(l, result, lines, i)),
        priceVariance: result.priceVariance,
        tolerance: settings,
        override,
      });
    }
    return out;
  }
}

function asMatchLine(l: FinanceVendorInvoiceLine): MatchInvoiceLine {
  return {
    position: l.position,
    orderLineId: l.purchaseOrderLineId,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: l.amount,
  };
}

function lineRead(
  l: FinanceVendorInvoiceLine,
  result: MatchResult,
  orderLines: readonly MatchOrderLine[],
  index: number,
): MatchLineRead {
  const order = l.purchaseOrderLineId
    ? orderLines.find((o) => o.id === l.purchaseOrderLineId)
    : undefined;
  const r = result.lines[index];
  return {
    ...r,
    description: l.description,
    invoiceQuantity: l.quantity?.toFixed(3) ?? null,
    invoiceUnitPrice: l.unitPrice?.toFixed(2) ?? null,
    amount: show(l.amount),
    orderDescription: order?.description ?? null,
    orderedQuantity: order ? money(order.ordered).toFixed(3) : null,
    orderUnitPrice: order ? money(order.unitPrice).toFixed(2) : null,
    acceptedQuantity: order ? money(order.accepted).toFixed(3) : null,
    otherInvoicedQuantity: order ? money(order.otherInvoiced).toFixed(3) : null,
  };
}
