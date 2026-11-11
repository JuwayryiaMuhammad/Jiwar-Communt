import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceBudgetLine,
  type FinanceCommitment,
  type FinanceVendorInvoice,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  PayablesBridge,
  type CommitmentItem,
  type CommitmentReleaseReason,
  type CommitmentSource,
} from '../../core/payables/payables-bridge';
import { asDate, dbNow, fromDate } from '../db-clock';
import { money, show, ZERO } from '../money';
import { BudgetsService } from '../budgets/budgets.service';

export interface CommitmentRecord {
  commitment: FinanceCommitment;
  released: Prisma.Decimal;
  open: Prisma.Decimal;
  category: string;
}

const PAGE = keysetCursor('createdAt', 'desc');

export const lineInsufficient = (available: Prisma.Decimal) =>
  appError.conflict(
    ErrorCode.BUDGET_LINE_INSUFFICIENT,
    'More than the line has available',
    { params: { available: show(available) } },
  );

/**
 * Budget lines held for what was agreed (ADR 0089). Every writer of a
 * line's money — an expense, a transfer, a commitment, an invoice's
 * approval, a payout — takes the lines' budgets shared and the lines for
 * update in id order, then decides by what it reads after them: two of them
 * never count the same money twice.
 */
export async function lockLines(
  tx: TenantTxClient,
  budgets: BudgetsService,
  lineIds: readonly string[],
): Promise<Map<string, FinanceBudgetLine>> {
  const ids = [...new Set(lineIds)].sort();
  const seen = await tx.financeBudgetLine.findMany({
    where: { id: { in: ids } },
    select: { id: true, budgetId: true },
  });
  for (const b of [...new Set(seen.map((l) => l.budgetId))].sort())
    await budgets.lock(tx, b, 'share');
  const out = new Map<string, FinanceBudgetLine>();
  for (const l of seen.map((x) => x.id).sort())
    out.set(l, await budgets.lockLine(tx, l));
  return out;
}

/**
 * The commitment keeper (ADR 0089), registered with core's PayablesBridge
 * for maintenance's contracts, purchase requests and purchase orders: a
 * contract's unpaid payments due within its line's active budget, an
 * approved purchase request, and an approved purchase order (ADR 0094, the
 * same budget as its request's, taken over by it), keep their line's budget
 * until invoiced, changed, cancelled, terminated, ordered, closed or paid
 * by hand. Called in the source's transaction, under
 * the source's own row lock, then the lines' (see lockLines).
 */
@Injectable()
export class CommitmentsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly bridge: PayablesBridge,
    private readonly budgets: BudgetsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.bridge.registerCommitments({
      sync: (tx, ev) => this.sync(tx, ev),
      assertNotInvoiced: (tx, ids) => this.assertNotInvoiced(tx, ids),
    });
  }

  list(q: {
    lineId?: string;
    source?: CommitmentSource;
    open?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<CommitmentRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.financeCommitment.findMany({
        where: {
          AND: [
            q.lineId ? { lineId: q.lineId } : {},
            q.source ? { source: q.source } : {},
            q.open === true ? { closedAt: null } : {},
            q.open === false ? { closedAt: { not: null } } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.records(tx, page.items) };
    });
  }

  /** Open commitments with what each still keeps, its category beside. */
  async records(
    tx: TenantTxClient,
    rows: FinanceCommitment[],
  ): Promise<CommitmentRecord[]> {
    if (!rows.length) return [];
    const released = await this.releasedOf(
      tx,
      rows.map((r) => r.id),
    );
    const lines = await tx.financeBudgetLine.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.lineId))] } },
      select: { id: true, category: true },
    });
    const category = new Map(lines.map((l) => [l.id, l.category]));
    return rows.map((c) => {
      const r = released.get(c.id) ?? ZERO;
      return {
        commitment: c,
        released: r,
        open: money(c.amount).sub(r),
        category: category.get(c.lineId) ?? 'other',
      };
    });
  }

  // --------------------------------------------------------------------------
  // The keeper (core's PayablesBridge)
  // --------------------------------------------------------------------------

  private async sync(
    tx: TenantTxClient,
    ev: {
      source: CommitmentSource;
      sourceId: string;
      items: readonly CommitmentItem[];
      reason: CommitmentReleaseReason;
    },
  ): Promise<void> {
    const open = await tx.financeCommitment.findMany({
      where: {
        closedAt: null,
        ...(ev.source === 'contract'
          ? { contractId: ev.sourceId }
          : ev.source === 'purchase_order'
            ? { purchaseOrderId: ev.sourceId }
            : { purchaseRequestId: ev.sourceId }),
      },
    });
    // An item a live invoice names keeps its commitment as it is: the
    // invoice's approval releases it.
    const invoiced = new Set<string>();
    if (ev.source === 'contract') {
      const live = await tx.financeVendorInvoice.findMany({
        where: {
          contractId: ev.sourceId,
          contractPaymentId: { not: null },
          status: { in: ['received', 'approved'] },
        },
        select: { contractPaymentId: true },
      });
      for (const i of live) invoiced.add(i.contractPaymentId!);
    }
    const itemOf = (c: FinanceCommitment) =>
      (ev.source === 'contract'
        ? c.contractPaymentId
        : ev.source === 'purchase_order'
          ? c.purchaseOrderId
          : c.purchaseRequestId)!;
    const wanted = ev.items.filter((i) => !invoiced.has(i.itemId));
    const lines = await lockLines(tx, this.budgets, [
      ...open.map((c) => c.lineId),
      ...wanted.map((i) => i.lineId),
    ]);
    // Only what falls in a line's active budget is kept: a contract's
    // payment by its day; a purchase by its line.
    const usable = new Map<string, { from: string; to: string } | null>();
    for (const [id, line] of lines) {
      const b = await tx.financeBudget.findUniqueOrThrow({
        where: { id: line.budgetId },
      });
      usable.set(
        id,
        b.status === 'active'
          ? { from: fromDate(b.startsOn), to: fromDate(b.endsOn) }
          : null,
      );
    }
    const keep = wanted.filter((i) => {
      const w = usable.get(i.lineId);
      if (!w) return false;
      if (ev.source !== 'contract' || !i.dueOn) return true;
      return i.dueOn >= w.from && i.dueOn <= w.to;
    });
    const same = (c: FinanceCommitment, i: CommitmentItem) =>
      c.lineId === i.lineId &&
      money(c.amount).equals(i.amount) &&
      (c.dueOn ? fromDate(c.dueOn) : null) === i.dueOn;
    const now = await dbNow(tx);
    const kept = new Set<string>();
    for (const c of open) {
      const item = itemOf(c);
      if (invoiced.has(item)) {
        kept.add(item);
        continue;
      }
      const w = keep.find((i) => i.itemId === item);
      if (w && same(c, w)) {
        kept.add(item);
        continue;
      }
      await this.releaseWhole(tx, c, ev.reason, now);
    }
    for (const i of keep) {
      if (kept.has(i.itemId)) continue;
      const line = lines.get(i.lineId)!;
      const { available } = await this.budgets.figuresOf(tx, line);
      if (money(i.amount).gt(available)) throw lineInsufficient(available);
      const id = newId();
      await tx.financeCommitment.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          lineId: i.lineId,
          source: ev.source,
          contractId: ev.source === 'contract' ? ev.sourceId : null,
          contractPaymentId: ev.source === 'contract' ? i.itemId : null,
          purchaseRequestId: ev.source === 'purchase_request' ? i.itemId : null,
          purchaseOrderId: ev.source === 'purchase_order' ? i.itemId : null,
          vendorId: i.vendorId,
          amount: i.amount,
          dueOn: i.dueOn ? asDate(i.dueOn) : null,
          createdById: this.ctx.accountIdOrNull(),
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'finance_commitment.reserved',
        targetId: id,
        metadata: {
          source: ev.source,
          sourceId: ev.sourceId,
          itemId: i.itemId,
          lineId: i.lineId,
          amount: show(i.amount),
          dueOn: i.dueOn,
        },
      });
    }
  }

  private async assertNotInvoiced(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<void> {
    if (!ids.length) return;
    const live = await tx.financeVendorInvoice.findFirst({
      where: {
        contractPaymentId: { in: [...ids] },
        status: { in: ['received', 'approved'] },
      },
      select: { id: true },
    });
    if (live)
      throw appError.conflict(
        ErrorCode.CONTRACT_PAYMENT_INVOICED,
        'A vendor invoice names this payment',
        { params: { invoiceId: live.id } },
      );
  }

  // --------------------------------------------------------------------------
  // For the invoices, in their transactions (the lines locked already)
  // --------------------------------------------------------------------------

  /** The open commitment an invoice's item holds, or null. */
  openFor(
    tx: TenantTxClient,
    invoice: Pick<
      FinanceVendorInvoice,
      'contractPaymentId' | 'purchaseRequestId' | 'purchaseOrderId'
    >,
  ): Promise<FinanceCommitment | null> {
    if (invoice.purchaseOrderId)
      return tx.financeCommitment.findFirst({
        where: { purchaseOrderId: invoice.purchaseOrderId, closedAt: null },
      });
    if (invoice.contractPaymentId)
      return tx.financeCommitment.findFirst({
        where: { contractPaymentId: invoice.contractPaymentId, closedAt: null },
      });
    if (invoice.purchaseRequestId)
      return tx.financeCommitment.findFirst({
        where: { purchaseRequestId: invoice.purchaseRequestId, closedAt: null },
      });
    return Promise.resolve(null);
  }

  /** Released by an approved invoice: its total, up to what is open. */
  async releaseForInvoice(
    tx: TenantTxClient,
    c: FinanceCommitment,
    invoice: FinanceVendorInvoice,
    now: Date,
  ): Promise<Prisma.Decimal> {
    const open = money(c.amount).sub(
      (await this.releasedOf(tx, [c.id])).get(c.id) ?? ZERO,
    );
    const amount = Prisma.Decimal.min(open, money(invoice.total));
    if (amount.lte(0)) return ZERO;
    await this.release(tx, c, amount, 'invoiced', invoice.id, now);
    if (amount.equals(open))
      await tx.financeCommitment.update({
        where: { id: c.id },
        data: { closedAt: now },
      });
    return amount;
  }

  /** What an item's commitment still keeps, given back whole, if it is open. */
  async closeRest(
    tx: TenantTxClient,
    commitmentId: string,
    reason: CommitmentReleaseReason,
    now: Date,
  ): Promise<void> {
    const c = await tx.financeCommitment.findUniqueOrThrow({
      where: { id: commitmentId },
    });
    if (!c.closedAt) await this.releaseWhole(tx, c, reason, now);
  }

  private async releaseWhole(
    tx: TenantTxClient,
    c: FinanceCommitment,
    reason: CommitmentReleaseReason,
    now: Date,
  ): Promise<void> {
    const open = money(c.amount).sub(
      (await this.releasedOf(tx, [c.id])).get(c.id) ?? ZERO,
    );
    if (open.gt(0)) await this.release(tx, c, open, reason, null, now);
    await tx.financeCommitment.update({
      where: { id: c.id },
      data: { closedAt: now },
    });
  }

  private async release(
    tx: TenantTxClient,
    c: FinanceCommitment,
    amount: Prisma.Decimal,
    reason: CommitmentReleaseReason | 'invoiced',
    invoiceId: string | null,
    now: Date,
  ): Promise<void> {
    await tx.financeCommitmentRelease.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        commitmentId: c.id,
        amount: show(amount),
        reason,
        vendorInvoiceId: invoiceId,
        createdById: this.ctx.accountIdOrNull(),
        createdAt: now,
      },
    });
    await this.audit.record(tx, {
      action: 'finance_commitment.released',
      targetId: c.id,
      metadata: {
        reason,
        amount: show(amount),
        lineId: c.lineId,
        invoiceId,
      },
    });
  }

  private async releasedOf(
    tx: TenantTxClient,
    ids: string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const rows = await tx.financeCommitmentRelease.groupBy({
      by: ['commitmentId'],
      where: { commitmentId: { in: ids } },
      _sum: { amount: true },
    });
    return new Map(
      rows.map((r) => [r.commitmentId, money(r._sum.amount ?? 0)]),
    );
  }
}
