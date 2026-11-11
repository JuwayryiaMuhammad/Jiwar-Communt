import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseOrderRevision,
} from '@prisma/client';
import { PermissionsService } from '../../core/access/permissions.service';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import {
  PayablesBridge,
  type CommitmentItem,
} from '../../core/payables/payables-bridge';
import { claimApproval } from '../purchases/approval-claims';
import {
  ContractorAccess,
  contractorsOf,
} from '../contractors/contractor-access';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  dateColumn,
  ofDateColumn,
  type LocalDate,
} from '../schedules/local-dates';
import {
  nextProcurementNumber,
  VendorsService,
} from '../vendors/vendors.service';
import { GoodsReceiptsService, type ReceiptRecord } from './goods-receipts';
import { lockOrder, OrderProgress, orderNotFound } from './order-progress';
import {
  lineNet,
  lineVat,
  ORDER_LIMITS,
  orderReference,
  orderTotals,
  type LineKind,
  type LineTaxCode,
  type OrderSource,
  type OrderStatus,
  type OrderWithholdingCategory,
} from './purchase-order-rules';

export const PURCHASE_ORDER_RESOURCE = 'purchase_order';

/** One line as a raiser writes it (and as a revision keeps it). */
export interface OrderLineInput {
  /** An amendment: the existing line it changes; absent: a new line. */
  id?: string;
  kind: LineKind;
  stockItemId?: string;
  description?: string;
  quantity: string;
  unit?: string;
  unitPrice: string;
  taxCode?: LineTaxCode;
  withholdingCategory?: OrderWithholdingCategory;
}

export interface NewOrder {
  vendorId?: string;
  budgetLineId?: string;
  purchaseRequestId?: string;
  tenderId?: string;
  deliveryOn: LocalDate;
  note?: string;
  lines: OrderLineInput[];
}

export interface OrderAmendment {
  reasonCode?: string;
  budgetLineId?: string;
  deliveryOn?: LocalDate;
  note?: string;
  lines: OrderLineInput[];
}

/** A line with what has happened to it. */
export interface OrderLineRead {
  line: PurchaseOrderLine;
  accepted: Prisma.Decimal;
  rejected: Prisma.Decimal;
  /** Billed on approved or paid invoices. */
  invoiced: Prisma.Decimal;
}

export interface OrderRecord {
  order: PurchaseOrder;
  vendorName: string;
  lines: OrderLineRead[];
  /** Every revision, newest first. */
  revisions: PurchaseOrderRevision[];
  receipts: ReceiptRecord[];
  invoices: { id: string; number: number; status: string; total: string }[];
  /** What its commitment still keeps. */
  committed: Prisma.Decimal;
  raisedByMe: boolean;
  /** The caller, to tell which revisions are theirs. */
  viewerId: string;
}

/** The snapshot a revision keeps of each line. */
interface LineSnapshot {
  id: string;
  kind: LineKind;
  stockItemId: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxCode: LineTaxCode;
  withholdingCategory: OrderWithholdingCategory | null;
}

const PAGE = keysetCursor('raisedAt');

const wrongState = (status: string) =>
  appError.conflict(
    ErrorCode.PURCHASE_ORDER_STATE,
    'The purchase order is not in a state that allows this',
    { params: { status } },
  );
const sourceInvalid = (reason: string, extra: Record<string, unknown> = {}) =>
  appError.conflict(
    ErrorCode.PURCHASE_ORDER_SOURCE_INVALID,
    'What this order is raised from cannot take one',
    { params: { reason, ...extra } },
  );
const approvalInvalid = (
  reason: 'not_approved' | 'below_amount' | 'covers_another',
) =>
  appError.conflict(
    ErrorCode.PURCHASE_ORDER_APPROVAL_INVALID,
    'That approval cannot cover this order',
    { params: { reason } },
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid purchase order', {
    fields,
  });
const selfApproval = () =>
  appError.conflict(
    ErrorCode.PURCHASE_ORDER_SELF_APPROVAL,
    'You raised this order: someone else approves it',
  );

/**
 * Purchase orders (ADR 0094), the step after a purchase request (ADR 0077)
 * and the one a tender's award (ADR 0088) can lead to. Raised with
 * `purchase_orders.raise` from an approved request, an award or directly,
 * with a vendor of the register, a budget line, a delivery day and lines
 * (a stock item, goods or a service: quantity, unit, unit price, VAT and
 * withholding category). Approved with `purchases.approve` by who did not
 * raise it (even under the board's approval), up to the manager's limit or
 * under the board's approved major contract (ADR 0055, 0089). An approved
 * order keeps its line's budget as the commitment of ADR 0089 — the same
 * one its request kept, taken over, not a second — until invoiced,
 * changed, cancelled or closed.
 *
 * An approved order is amended by a new revision, approved again; one waits
 * at a time, and no line goes below what was received or invoiced of it.
 * What is left is cancelled with a code (the commitment of what was not
 * received is given back); the order closes once fully received and
 * invoiced, or when its remainder is cancelled. Sent to its vendor as a PDF
 * and seen by its contractors, who acknowledge it.
 *
 * Locks: the caller → the purchase request (update) → the order (update) →
 * the vendor (shared) → the threshold's row (shared) → the approval request
 * → its claim lock → the lines' budgets (shared) and lines (update) → the
 * stock items (update) → the counter.
 */
@Injectable()
export class PurchaseOrdersService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly permissions: PermissionsService,
    private readonly vendors: VendorsService,
    private readonly matters: BoardMatters,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly payables: PayablesBridge,
    private readonly receipts: GoodsReceiptsService,
    private readonly progressOf: OrderProgress,
    private readonly contractor: ContractorAccess,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PURCHASE_ORDER_RESOURCE, (id) => this.get(id));
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  async list(q: {
    status?: OrderStatus;
    vendorId?: string;
    purchaseRequestId?: string;
    tenderId?: string;
    waiting?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<OrderRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.purchaseOrder.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.vendorId ? { vendorId: q.vendorId } : {},
            q.purchaseRequestId
              ? { purchaseRequestId: q.purchaseRequestId }
              : {},
            q.tenderId ? { tenderId: q.tenderId } : {},
            // Waiting for a decision: a first approval or a revision.
            q.waiting
              ? {
                  OR: [
                    { status: 'requested' },
                    { pendingRevision: { not: null } },
                  ],
                }
              : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: OrderRecord[] = [];
      for (const o of page.items) items.push(await this.load(tx, o));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<OrderRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const o = await tx.purchaseOrder.findUnique({ where: { id } });
      if (!o) throw orderNotFound();
      return this.load(tx, o);
    });
  }

  /** Orders sent to a vendor (a contractor's view), newest first. */
  sentTo(
    vendorId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<OrderRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.purchaseOrder.findMany({
        where: {
          AND: [
            { vendorId, sentAt: { not: null } },
            { status: { in: ['approved', 'closed'] } },
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: OrderRecord[] = [];
      for (const o of page.items) items.push(await this.load(tx, o));
      return { items, nextCursor: page.nextCursor };
    });
  }

  /** One order sent to a vendor: null when it is another's or not sent. */
  async sentOne(vendorId: string, id: string): Promise<OrderRecord | null> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const o = await tx.purchaseOrder.findFirst({
        where: {
          id,
          vendorId,
          sentAt: { not: null },
          status: { in: ['approved', 'closed'] },
        },
      });
      return o ? this.load(tx, o) : null;
    });
  }

  // --------------------------------------------------------------------------
  // Raised
  // --------------------------------------------------------------------------

  raise(input: NewOrder): Promise<OrderRecord> {
    if (input.purchaseRequestId && input.tenderId)
      throw invalid([
        { field: 'tenderId', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, { type: PURCHASE_ORDER_RESOURCE, id });
        const { today } = await this.calendar.now(tx);
        if (input.deliveryOn < today)
          throw invalid([
            {
              field: 'deliveryOn',
              code: FieldErrorCode.DAY_OUT_OF_RANGE,
              params: { min: today },
            },
          ]);
        const lines = await this.snapshots(tx, input.lines, null);
        const totals = totalsOf(lines);
        // What it is raised from, locked first.
        let source: OrderSource = 'direct';
        let vendorId = input.vendorId ?? null;
        let budgetLineId = input.budgetLineId ?? null;
        let contractId: string | null = null;
        if (input.purchaseRequestId) {
          source = 'purchase_request';
          const r = await this.lockRequest(tx, input.purchaseRequestId);
          if (r.status !== 'approved')
            throw sourceInvalid('request_not_approved', { status: r.status });
          if (await this.liveOrderOf(tx, r.id))
            throw sourceInvalid('already_ordered');
          if (r.vendorId && vendorId && r.vendorId !== vendorId)
            throw sourceInvalid('vendor_mismatch');
          vendorId = vendorId ?? r.vendorId;
          budgetLineId = budgetLineId ?? r.budgetLineId;
        } else if (input.tenderId) {
          source = 'tender';
          const t = await this.lockTender(tx, input.tenderId);
          if (t.status !== 'awarded' || !t.contractId || !t.awardedBidId)
            throw sourceInvalid('tender_not_awarded', { status: t.status });
          const contract = await tx.maintenanceContract.findUniqueOrThrow({
            where: { id: t.contractId },
          });
          if (vendorId && vendorId !== contract.vendorId)
            throw sourceInvalid('vendor_mismatch');
          vendorId = contract.vendorId;
          budgetLineId = budgetLineId ?? t.budgetLineId;
          contractId = contract.id;
          // A contract with a schedule already keeps its line's budget: an
          // order would keep it twice.
          if (
            await tx.maintenanceContractPayment.findFirst({
              where: { contractId: contract.id, paidAt: null },
              select: { id: true },
            })
          )
            throw sourceInvalid('contract_scheduled');
          const bid = await tx.tenderBid.findUniqueOrThrow({
            where: { id: t.awardedBidId },
            select: { amount: true },
          });
          const ordered = await this.orderedFromTender(tx, t.id);
          if (
            bid.amount &&
            ordered.add(totals.total).gt(new Prisma.Decimal(bid.amount))
          )
            throw sourceInvalid('award_exceeded', {
              awarded: new Prisma.Decimal(bid.amount).toFixed(2),
              ordered: ordered.toFixed(2),
            });
        }
        if (!vendorId)
          throw invalid([
            { field: 'vendorId', code: FieldErrorCode.FIELD_REQUIRED },
          ]);
        if (!budgetLineId)
          throw invalid([
            { field: 'budgetLineId', code: FieldErrorCode.FIELD_REQUIRED },
          ]);
        await this.vendors.lockUsable(tx, vendorId);
        await this.requireLine(tx, budgetLineId);
        const note = input.note?.trim() || null;
        const number = await nextProcurementNumber(
          tx,
          this.ctx.tenantId,
          'purchase_order',
        );
        const now = await dbNow(tx);
        await tx.purchaseOrder.create({
          data: {
            id,
            tenantId: this.ctx.tenantId,
            number,
            vendorId,
            budgetLineId,
            source,
            purchaseRequestId: input.purchaseRequestId ?? null,
            tenderId: input.tenderId ?? null,
            contractId,
            deliveryOn: dateColumn(input.deliveryOn),
            note,
            revision: 1,
            status: 'requested',
            subtotal: totals.subtotal.toFixed(2),
            tax: totals.tax.toFixed(2),
            total: totals.total.toFixed(2),
            raisedById: this.ctx.accountId,
            raisedAt: now,
          },
        });
        await this.writeLines(tx, id, lines);
        await tx.purchaseOrderRevision.create({
          data: {
            id: newId(),
            tenantId: this.ctx.tenantId,
            purchaseOrderId: id,
            revision: 1,
            budgetLineId,
            deliveryOn: dateColumn(input.deliveryOn),
            note,
            lines: lines as unknown as Prisma.InputJsonValue,
            subtotal: totals.subtotal.toFixed(2),
            tax: totals.tax.toFixed(2),
            total: totals.total.toFixed(2),
            requestedById: this.ctx.accountId,
            requestedAt: now,
          },
        });
        await this.audit.record(tx, {
          action: 'purchase_order.raised',
          targetId: id,
          metadata: {
            number,
            source,
            vendorId,
            budgetLineId,
            purchaseRequestId: input.purchaseRequestId ?? null,
            tenderId: input.tenderId ?? null,
            deliveryOn: input.deliveryOn,
            lines: lines.length,
            subtotal: totals.subtotal.toFixed(2),
            tax: totals.tax.toFixed(2),
            total: totals.total.toFixed(2),
          },
          ...(note ? { changes: { note: { changed: true } } } : {}),
        });
        await this.tellApprovers(tx, id, number);
        return id;
      })
      .then((id) => this.get(id));
  }

  // --------------------------------------------------------------------------
  // Decided
  // --------------------------------------------------------------------------

  /**
   * Approves what waits: the order's first revision, or an amendment. By a
   * holder of `purchases.approve` who did not raise it; above the manager's
   * limit under the board's approved major contract. Keeps (or re-keeps)
   * the budget as one commitment.
   */
  approve(
    id: string,
    input: { approvalRequestId?: string; note?: string },
  ): Promise<OrderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        const { revision, first } = await this.waiting(tx, before);
        if (revision.requestedById === this.ctx.accountId) throw selfApproval();
        await this.vendors.lockUsable(tx, before.vendorId);
        const total = new Prisma.Decimal(revision.total);
        const approvalRequestId = await this.coveredBy(
          tx,
          before,
          total,
          input.approvalRequestId ?? null,
        );
        const lines = revision.lines as unknown as LineSnapshot[];
        const note = input.note?.trim() || null;
        const now = await dbNow(tx);
        if (first) {
          // The request's commitment is taken over, never kept twice.
          if (before.purchaseRequestId) {
            const request = await this.lockRequest(
              tx,
              before.purchaseRequestId,
            );
            if (request.status !== 'approved')
              throw sourceInvalid('request_not_approved', {
                status: request.status,
              });
            await this.payables.commitments.sync(tx, {
              source: 'purchase_request',
              sourceId: before.purchaseRequestId,
              items: [],
              reason: 'ordered',
            });
            await tx.purchaseRequest.update({
              where: { id: before.purchaseRequestId },
              data: {
                status: 'fulfilled',
                fulfilledById: this.ctx.accountId,
                fulfilledAt: now,
                fulfilledReference: orderReference(before.number),
              },
            });
          }
        } else {
          await this.applyRevision(tx, before, revision, lines);
        }
        await this.keep(tx, {
          orderId: id,
          vendorId: before.vendorId,
          lineId: revision.budgetLineId,
          deliveryOn: ofDateColumn(revision.deliveryOn),
          total,
        });
        await tx.purchaseOrderRevision.update({
          where: { id: revision.id },
          data: {
            status: 'approved',
            decidedById: this.ctx.accountId,
            decidedAt: now,
            decisionNote: note,
            approvalRequestId,
          },
        });
        await tx.purchaseOrder.update({
          where: { id },
          data: first
            ? {
                status: 'approved',
                decidedById: this.ctx.accountId,
                decidedAt: now,
                decisionNote: note,
                approvalRequestId,
              }
            : { approvalRequestId },
        });
        await this.audit.record(tx, {
          action: first
            ? 'purchase_order.approved'
            : 'purchase_order.revision_approved',
          targetId: id,
          metadata: {
            revision: revision.revision,
            approvalRequestId,
            total: total.toFixed(2),
          },
          ...(note ? { changes: { decisionNote: { changed: true } } } : {}),
        });
        await this.tellRaiser(tx, before, revision.requestedById, 'approved');
      })
      .then(() => this.get(id));
  }

  reject(
    id: string,
    input: { reasonCode?: string; note?: string },
  ): Promise<OrderRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.purchaseOrderReject,
    );
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        const { revision, first } = await this.waiting(tx, before);
        if (revision.requestedById === this.ctx.accountId) throw selfApproval();
        const now = await dbNow(tx);
        const note = input.note?.trim() || null;
        await tx.purchaseOrderRevision.update({
          where: { id: revision.id },
          data: {
            status: 'rejected',
            decidedById: this.ctx.accountId,
            decidedAt: now,
            decisionNote: note,
            rejectReason: reason,
          },
        });
        await tx.purchaseOrder.update({
          where: { id },
          data: first
            ? {
                status: 'rejected',
                decidedById: this.ctx.accountId,
                decidedAt: now,
                decisionNote: note,
                rejectReason: reason,
              }
            : { pendingRevision: null },
        });
        await this.audit.record(tx, {
          action: first
            ? 'purchase_order.rejected'
            : 'purchase_order.revision_rejected',
          targetId: id,
          metadata: { revision: revision.revision, reasonCode: reason },
          ...(note ? { changes: { decisionNote: { changed: true } } } : {}),
        });
        await this.tellRaiser(tx, before, revision.requestedById, 'rejected');
      })
      .then(() => this.get(id));
  }

  // --------------------------------------------------------------------------
  // Amended, cancelled, closed
  // --------------------------------------------------------------------------

  /** A new revision of an approved order, to be approved again. */
  amend(id: string, input: OrderAmendment): Promise<OrderRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.purchaseOrderAmend,
    );
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'approved') throw wrongState(before.status);
        if (before.pendingRevision !== null)
          throw appError.conflict(
            ErrorCode.PURCHASE_ORDER_REVISION_PENDING,
            'A revision of this order waits for its decision',
            { params: { revision: before.pendingRevision } },
          );
        const { today } = await this.calendar.now(tx);
        const deliveryOn = input.deliveryOn ?? ofDateColumn(before.deliveryOn);
        if (input.deliveryOn && input.deliveryOn < today)
          throw invalid([
            {
              field: 'deliveryOn',
              code: FieldErrorCode.DAY_OUT_OF_RANGE,
              params: { min: today },
            },
          ]);
        const existing = await tx.purchaseOrderLine.findMany({
          where: { purchaseOrderId: id },
        });
        const lines = await this.snapshots(tx, input.lines, existing);
        await this.requireNotBelowUsed(tx, id, existing, lines);
        const totals = totalsOf(lines);
        const budgetLineId = input.budgetLineId ?? before.budgetLineId;
        if (budgetLineId !== before.budgetLineId)
          await this.requireLine(tx, budgetLineId);
        const note =
          input.note === undefined ? before.note : input.note.trim() || null;
        const last = await tx.purchaseOrderRevision.aggregate({
          where: { purchaseOrderId: id },
          _max: { revision: true },
        });
        const revision = (last._max.revision ?? before.revision) + 1;
        await tx.purchaseOrderRevision.create({
          data: {
            id: newId(),
            tenantId: this.ctx.tenantId,
            purchaseOrderId: id,
            revision,
            reasonCode: reason,
            budgetLineId,
            deliveryOn: dateColumn(deliveryOn),
            note,
            lines: lines as unknown as Prisma.InputJsonValue,
            subtotal: totals.subtotal.toFixed(2),
            tax: totals.tax.toFixed(2),
            total: totals.total.toFixed(2),
            requestedById: this.ctx.accountId,
            requestedAt: await dbNow(tx),
          },
        });
        await tx.purchaseOrder.update({
          where: { id },
          data: { pendingRevision: revision },
        });
        await this.audit.record(tx, {
          action: 'purchase_order.amended',
          targetId: id,
          metadata: {
            revision,
            reasonCode: reason,
            budgetLineId,
            deliveryOn,
            lines: lines.length,
            total: totals.total.toFixed(2),
          },
        });
        await this.tellApprovers(tx, id, before.number);
      })
      .then(() => this.get(id));
  }

  /** Who asked for the waiting revision takes it back. */
  withdrawRevision(id: string): Promise<OrderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'approved' || before.pendingRevision === null)
          throw wrongState(before.status);
        const { revision } = await this.waiting(tx, before);
        if (revision.requestedById !== this.ctx.accountId)
          throw orderNotFound();
        await tx.purchaseOrderRevision.update({
          where: { id: revision.id },
          data: {
            status: 'withdrawn',
            decidedById: this.ctx.accountId,
            decidedAt: await dbNow(tx),
          },
        });
        await tx.purchaseOrder.update({
          where: { id },
          data: { pendingRevision: null },
        });
        await this.audit.record(tx, {
          action: 'purchase_order.revision_withdrawn',
          targetId: id,
          metadata: { revision: revision.revision },
        });
      })
      .then(() => this.get(id));
  }

  /**
   * Cancelled with a code. A waiting order is called off (by who raised it
   * or an approver); an approved one has what is left cancelled: it closes,
   * and its commitment gives back everything but the value of what arrived
   * and is not yet invoiced.
   */
  async cancel(id: string, reasonCode?: string): Promise<OrderRecord> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.purchaseOrderCancel,
    );
    const approver = await this.permissions.has('purchases.approve');
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        const now = await dbNow(tx);
        if (before.status === 'requested') {
          if (!approver && before.raisedById !== this.ctx.accountId)
            throw orderNotFound();
          await tx.purchaseOrderRevision.updateMany({
            where: { purchaseOrderId: id, status: 'requested' },
            data: {
              status: 'withdrawn',
              decidedById: this.ctx.accountId,
              decidedAt: now,
            },
          });
          await tx.purchaseOrder.update({
            where: { id },
            data: {
              status: 'cancelled',
              cancelledById: this.ctx.accountId,
              cancelledAt: now,
              cancelReason: reason,
            },
          });
          await this.audit.record(tx, {
            action: 'purchase_order.cancelled',
            targetId: id,
            metadata: { reasonCode: reason },
          });
          return;
        }
        if (before.status !== 'approved') throw wrongState(before.status);
        if (before.pendingRevision !== null)
          await tx.purchaseOrderRevision.updateMany({
            where: { purchaseOrderId: id, status: 'requested' },
            data: {
              status: 'withdrawn',
              decidedById: this.ctx.accountId,
              decidedAt: now,
            },
          });
        const facts = await this.progressOf.facts(tx, id);
        const keepValue = this.progressOf.receivedNotInvoiced(facts);
        await this.progressOf.keepOnly(tx, before, keepValue, 'cancelled');
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            status: 'closed',
            closedAt: now,
            closeReason: 'remainder_cancelled',
            pendingRevision: null,
            cancelledById: this.ctx.accountId,
            cancelledAt: now,
            cancelReason: reason,
          },
        });
        await this.audit.record(tx, {
          action: 'purchase_order.remainder_cancelled',
          targetId: id,
          metadata: {
            reasonCode: reason,
            keptCommitment: keepValue.toFixed(2),
          },
        });
      })
      .then(() => this.get(id));
  }

  // --------------------------------------------------------------------------
  // Sent and acknowledged
  // --------------------------------------------------------------------------

  /** Sent to its vendor (its PDF, its contractors told); again after a revision. */
  send(id: string): Promise<OrderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'approved') throw wrongState(before.status);
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            sentById: this.ctx.accountId,
            sentAt: await dbNow(tx),
            sentRevision: before.revision,
          },
        });
        await this.audit.record(tx, {
          action: 'purchase_order.sent',
          targetId: id,
          metadata: { revision: before.revision, vendorId: before.vendorId },
        });
        await this.notifier.notify(
          tx,
          await contractorsOf(
            tx,
            before.vendorId,
            'purchase_orders.acknowledge',
          ),
          {
            kind: 'purchase_order.sent',
            params: { orderRef: orderReference(before.number) },
            targetId: id,
          },
        );
      })
      .then(() => this.get(id));
  }

  /** A contractor of the order's vendor acknowledges the revision sent. */
  acknowledge(id: string): Promise<OrderRecord> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const { vendorId } = await this.contractor.lockSelf(tx);
        const before = await this.lock(tx, id);
        // Another vendor's order is the same 404 as an unknown one.
        if (before.vendorId !== vendorId || before.sentAt === null)
          throw orderNotFound();
        if (before.status !== 'approved') throw wrongState(before.status);
        const seen = before.sentRevision ?? before.revision;
        if (
          before.acknowledgedRevision !== null &&
          before.acknowledgedRevision >= seen
        )
          return;
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            acknowledgedById: this.ctx.accountId,
            acknowledgedAt: await dbNow(tx),
            acknowledgedRevision: seen,
          },
        });
        await this.audit.record(tx, {
          action: 'purchase_order.acknowledged',
          targetId: id,
          metadata: { revision: seen, vendorId },
        });
      })
      .then(() => this.get(id));
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** The order, locked for update. */
  private lock(tx: TenantTxClient, id: string): Promise<PurchaseOrder> {
    return lockOrder(tx, id);
  }

  /** The gross total of the invoices of the order approved or paid. */
  private async invoicedGross(
    tx: TenantTxClient,
    id: string,
  ): Promise<Prisma.Decimal> {
    const [row] = await tx.$queryRaw<{ total: Prisma.Decimal | null }[]>`
      SELECT sum(total) AS total FROM finance_vendor_invoices
       WHERE purchase_order_id = ${id}::uuid AND status IN ('approved', 'paid')`;
    return new Prisma.Decimal(row?.total ?? 0);
  }

  /**
   * Keeps the order's line budget at `total` less what approved invoices
   * took: one commitment (ADR 0089), none when nothing is left.
   */
  private async keep(
    tx: TenantTxClient,
    o: {
      orderId: string;
      vendorId: string;
      lineId: string;
      deliveryOn: string;
      total: Prisma.Decimal;
    },
  ): Promise<void> {
    const left = Prisma.Decimal.max(
      o.total.sub(await this.invoicedGross(tx, o.orderId)),
      0,
    );
    const items: CommitmentItem[] = left.gt(0)
      ? [
          {
            itemId: o.orderId,
            lineId: o.lineId,
            amount: left.toFixed(2),
            dueOn: o.deliveryOn,
            vendorId: o.vendorId,
          },
        ]
      : [];
    await this.payables.commitments.sync(tx, {
      source: 'purchase_order',
      sourceId: o.orderId,
      items,
      reason: 'changed',
    });
  }

  /** The revision that waits, and whether it is the order's first. */
  private async waiting(
    tx: TenantTxClient,
    o: PurchaseOrder,
  ): Promise<{ revision: PurchaseOrderRevision; first: boolean }> {
    const first = o.status === 'requested';
    if (!first && !(o.status === 'approved' && o.pendingRevision !== null))
      throw wrongState(o.status);
    const revision = await tx.purchaseOrderRevision.findFirst({
      where: { purchaseOrderId: o.id, status: 'requested' },
    });
    if (!revision) throw wrongState(o.status);
    return { revision, first };
  }

  /** Writes an approved amendment to the order and its lines. */
  private async applyRevision(
    tx: TenantTxClient,
    o: PurchaseOrder,
    revision: PurchaseOrderRevision,
    lines: LineSnapshot[],
  ): Promise<void> {
    const existing = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: o.id },
    });
    await this.requireNotBelowUsed(tx, o.id, existing, lines);
    const kept = new Set(lines.map((l) => l.id));
    const known = new Map(existing.map((l) => [l.id, l]));
    // A line keeps its position for good; a new one takes the lowest free.
    const gone = existing.filter((l) => !kept.has(l.id));
    if (gone.length)
      await tx.purchaseOrderLine.deleteMany({
        where: { id: { in: gone.map((l) => l.id) } },
      });
    const taken = new Set(
      existing.filter((l) => kept.has(l.id)).map((l) => l.position),
    );
    for (const l of lines) {
      const was = known.get(l.id);
      if (was) {
        await tx.purchaseOrderLine.update({
          where: { id: l.id },
          data: lineData(l),
        });
        continue;
      }
      let position = 1;
      while (taken.has(position)) position += 1;
      if (position > ORDER_LIMITS.lines)
        throw invalid([
          {
            field: 'lines',
            code: FieldErrorCode.INVALID_VALUE,
            params: { max: ORDER_LIMITS.lines },
          },
        ]);
      taken.add(position);
      await tx.purchaseOrderLine.create({
        data: {
          id: l.id,
          tenantId: this.ctx.tenantId,
          purchaseOrderId: o.id,
          position,
          ...lineData(l),
        },
      });
    }
    await tx.purchaseOrder.update({
      where: { id: o.id },
      data: {
        budgetLineId: revision.budgetLineId,
        deliveryOn: revision.deliveryOn,
        note: revision.note,
        revision: revision.revision,
        pendingRevision: null,
        subtotal: revision.subtotal,
        tax: revision.tax,
        total: revision.total,
      },
    });
  }

  /** No line goes below what was accepted or invoiced of it; none with history is dropped. */
  private async requireNotBelowUsed(
    tx: TenantTxClient,
    id: string,
    existing: PurchaseOrderLine[],
    lines: readonly Pick<LineSnapshot, 'id' | 'quantity'>[],
  ): Promise<void> {
    const progress = await this.progressOf.progress(tx, id);
    const next = new Map(lines.map((l) => [l.id, l]));
    for (const e of existing) {
      const p = progress.get(e.id);
      const used = Prisma.Decimal.max(p?.accepted ?? 0, p?.invoiced ?? 0);
      const to = next.get(e.id);
      if (!to) {
        if (used.gt(0) || (await this.hasHistory(tx, e.id)))
          throw appError.conflict(
            ErrorCode.PURCHASE_ORDER_LINE_BELOW_USED,
            'A line cannot go below what was received or invoiced of it',
            { params: { lineId: e.id, min: used.toFixed(3) } },
          );
        continue;
      }
      if (new Prisma.Decimal(to.quantity).lt(used))
        throw appError.conflict(
          ErrorCode.PURCHASE_ORDER_LINE_BELOW_USED,
          'A line cannot go below what was received or invoiced of it',
          { params: { lineId: e.id, min: used.toFixed(3) } },
        );
    }
  }

  /** Whether a receipt or an invoice line (any status) names the line. */
  private async hasHistory(
    tx: TenantTxClient,
    lineId: string,
  ): Promise<boolean> {
    const [row] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM goods_receipt_lines WHERE purchase_order_line_id = ${lineId}::uuid)
           + (SELECT count(*) FROM finance_vendor_invoice_lines WHERE purchase_order_line_id = ${lineId}::uuid) AS n`;
    return row.n > 0n;
  }

  /**
   * Lines as snapshots, checked: a stock item that is active (its unit is
   * the line's), a description for the rest, an existing line's kind and
   * stock item never changed.
   */
  private async snapshots(
    tx: TenantTxClient,
    inputs: readonly OrderLineInput[],
    existing: PurchaseOrderLine[] | null,
  ): Promise<LineSnapshot[]> {
    const fields: FieldError[] = [];
    const out: LineSnapshot[] = [];
    const seen = new Set<string>();
    if (inputs.length < 1 || inputs.length > ORDER_LIMITS.lines)
      throw invalid([
        {
          field: 'lines',
          code: FieldErrorCode.INVALID_VALUE,
          params: { min: 1, max: ORDER_LIMITS.lines },
        },
      ]);
    for (const [i, l] of inputs.entries()) {
      const at = (f: string) => `lines.${i}.${f}`;
      const was = l.id ? existing?.find((e) => e.id === l.id) : undefined;
      if (l.id && (!existing || !was)) {
        fields.push({ field: at('id'), code: FieldErrorCode.INVALID_VALUE });
        continue;
      }
      if (l.id && seen.has(l.id)) {
        fields.push({ field: at('id'), code: FieldErrorCode.DUPLICATE_VALUE });
        continue;
      }
      if (l.id) seen.add(l.id);
      if (
        was &&
        (was.kind !== l.kind || was.stockItemId !== (l.stockItemId ?? null))
      )
        fields.push({ field: at('kind'), code: FieldErrorCode.INVALID_VALUE });
      let description = l.description?.trim() || '';
      let unit = l.unit ?? '';
      if (l.kind === 'stock') {
        if (!l.stockItemId) {
          fields.push({
            field: at('stockItemId'),
            code: FieldErrorCode.FIELD_REQUIRED,
          });
          continue;
        }
        const item = await tx.stockItem.findUnique({
          where: { id: l.stockItemId },
        });
        if (!item || (!item.active && !was)) {
          fields.push({
            field: at('stockItemId'),
            code: FieldErrorCode.STOCK_ITEM_NOT_AVAILABLE,
          });
          continue;
        }
        unit = item.unit;
        description = description || item.nameEn;
      } else {
        if (l.stockItemId)
          fields.push({
            field: at('stockItemId'),
            code: FieldErrorCode.FIELD_NOT_ALLOWED,
          });
        if (!description)
          fields.push({
            field: at('description'),
            code: FieldErrorCode.FIELD_REQUIRED,
          });
        if (!unit)
          fields.push({
            field: at('unit'),
            code: FieldErrorCode.FIELD_REQUIRED,
          });
      }
      out.push({
        id: l.id ?? newId(),
        kind: l.kind,
        stockItemId: l.kind === 'stock' ? l.stockItemId! : null,
        description: description.slice(0, 200),
        quantity: new Prisma.Decimal(l.quantity).toFixed(3),
        unit,
        unitPrice: new Prisma.Decimal(l.unitPrice).toFixed(2),
        taxCode: l.taxCode ?? 'zero',
        withholdingCategory: l.withholdingCategory ?? null,
      });
    }
    if (fields.length) throw invalid(fields);
    const total = totalsOf(out).total;
    if (total.gt('999999999.99'))
      throw invalid([
        {
          field: 'lines',
          code: FieldErrorCode.INVALID_VALUE,
          params: { max: '999999999.99' },
        },
      ]);
    return out;
  }

  private async writeLines(
    tx: TenantTxClient,
    orderId: string,
    lines: readonly LineSnapshot[],
  ): Promise<void> {
    await tx.purchaseOrderLine.createMany({
      data: lines.map((l, i) => ({
        id: l.id,
        tenantId: this.ctx.tenantId,
        purchaseOrderId: orderId,
        position: i + 1,
        ...lineData(l),
      })),
    });
  }

  /**
   * The approval it is covered by, or null within the manager’s limit. An
   * approval the order’s request, award or earlier revision was approved
   * under serves it when it covers the amount; one named is checked.
   */
  private async coveredBy(
    tx: TenantTxClient,
    o: PurchaseOrder,
    total: Prisma.Decimal,
    named: string | null,
  ): Promise<string | null> {
    const limit = await this.matters.threshold(tx, 'major_contract');
    const inherited = async (): Promise<string | null> => {
      if (o.approvalRequestId) return o.approvalRequestId;
      if (o.purchaseRequestId)
        return (
          (
            await tx.purchaseRequest.findUnique({
              where: { id: o.purchaseRequestId },
              select: { approvalRequestId: true },
            })
          )?.approvalRequestId ?? null
        );
      if (o.contractId)
        return (
          (
            await tx.maintenanceContract.findUnique({
              where: { id: o.contractId },
              select: { approvalRequestId: true },
            })
          )?.approvalRequestId ?? null
        );
      return null;
    };
    // Whether the approval can cover this order, and why not.
    const covers = async (
      id: string,
    ): Promise<'ok' | 'not_approved' | 'below_amount' | 'covers_another'> => {
      const a = await this.matters.approvalRequest(tx, id);
      if (!a || a.type !== 'major_contract' || a.status !== 'approved')
        return 'not_approved';
      if (a.cost !== null && total.gt(new Prisma.Decimal(a.cost)))
        return 'below_amount';
      // One claim of an approval at a time (two tables, no unique index
      // across them), by an order, a request or a contract.
      await claimApproval(tx, this.ctx.txTenantId, id);
      const other =
        (await tx.purchaseOrder.findFirst({
          where: { approvalRequestId: id, NOT: { id: o.id } },
          select: { id: true },
        })) ??
        (await tx.purchaseRequest.findFirst({
          where: {
            approvalRequestId: id,
            ...(o.purchaseRequestId
              ? { NOT: { id: o.purchaseRequestId } }
              : {}),
          },
          select: { id: true },
        })) ??
        (await tx.maintenanceContract.findFirst({
          where: {
            approvalRequestId: id,
            ...(o.contractId ? { NOT: { id: o.contractId } } : {}),
          },
          select: { id: true },
        }));
      return other ? 'covers_another' : 'ok';
    };
    if (named) {
      const verdict = await covers(named);
      if (verdict !== 'ok') throw approvalInvalid(verdict);
      return named;
    }
    const kept = await inherited();
    if (kept && (await covers(kept)) === 'ok') return kept;
    if (limit !== null && total.gt(new Prisma.Decimal(limit)))
      throw appError.conflict(
        ErrorCode.PURCHASE_ORDER_NEEDS_APPROVAL,
        'Above the manager’s limit: the board approves it as a major contract',
        { params: { threshold: limit } },
      );
    return null;
  }

  private async lockRequest(tx: TenantTxClient, id: string) {
    await tx.$queryRaw`SELECT id FROM purchase_requests WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await tx.purchaseRequest.findUnique({ where: { id } });
    if (!r)
      throw appError.notFound(
        ErrorCode.PURCHASE_REQUEST_NOT_FOUND,
        'Purchase request not found',
      );
    return r;
  }

  private async lockTender(tx: TenantTxClient, id: string) {
    await tx.$queryRaw`SELECT id FROM tenders WHERE id = ${id}::uuid FOR SHARE`;
    const t = await tx.tender.findUnique({ where: { id } });
    if (!t)
      throw appError.notFound(ErrorCode.TENDER_NOT_FOUND, 'Tender not found');
    return t;
  }

  private async liveOrderOf(
    tx: TenantTxClient,
    purchaseRequestId: string,
  ): Promise<boolean> {
    return (
      (await tx.purchaseOrder.findFirst({
        where: { purchaseRequestId, status: { in: ['requested', 'approved'] } },
        select: { id: true },
      })) !== null
    );
  }

  /** The gross of the live orders raised from a tender's award. */
  private async orderedFromTender(
    tx: TenantTxClient,
    tenderId: string,
  ): Promise<Prisma.Decimal> {
    const sum = await tx.purchaseOrder.aggregate({
      where: { tenderId, status: { in: ['requested', 'approved', 'closed'] } },
      _sum: { total: true },
    });
    return new Prisma.Decimal(sum._sum.total ?? 0);
  }

  private async requireLine(
    tx: TenantTxClient,
    budgetLineId: string,
  ): Promise<void> {
    if (
      !(await tx.financeBudgetLine.findUnique({ where: { id: budgetLineId } }))
    )
      throw invalid([
        {
          field: 'budgetLineId',
          code: FieldErrorCode.BUDGET_LINE_NOT_AVAILABLE,
        },
      ]);
  }

  private async tellApprovers(
    tx: TenantTxClient,
    id: string,
    number: number,
  ): Promise<void> {
    const approvers = (
      await this.staff.holding(tx, 'purchases.approve')
    ).filter((a) => a.id !== this.ctx.accountId);
    await this.notifier.notify(
      tx,
      approvers.map((a) => a.id),
      {
        kind: 'purchase_order.submitted',
        params: { orderRef: orderReference(number) },
        targetId: id,
      },
    );
  }

  private async tellRaiser(
    tx: TenantTxClient,
    o: PurchaseOrder,
    requesterId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    if (requesterId === this.ctx.accountId) return;
    await this.notifier.notify(tx, [requesterId], {
      kind: 'purchase_order.decided',
      params: { orderRef: orderReference(o.number), decision },
      targetId: o.id,
    });
  }

  private async load(
    tx: TenantTxClient,
    order: PurchaseOrder,
  ): Promise<OrderRecord> {
    const lines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: order.id },
      orderBy: { position: 'asc' },
    });
    const revisions = await tx.purchaseOrderRevision.findMany({
      where: { purchaseOrderId: order.id },
      orderBy: { revision: 'desc' },
    });
    const vendor = await tx.vendor.findUniqueOrThrow({
      where: { id: order.vendorId },
      select: { name: true },
    });
    const invoices = await tx.financeVendorInvoice.findMany({
      where: { purchaseOrderId: order.id },
      orderBy: { number: 'asc' },
      select: { id: true, number: true, status: true, total: true },
    });
    const progress = await this.progressOf.progress(tx, order.id);
    const receipts = await this.receipts.forOrder(tx, order.id);
    const zero = new Prisma.Decimal(0);
    const [committed] = await tx.$queryRaw<{ open: Prisma.Decimal | null }[]>`
      SELECT sum(c.amount - COALESCE((
               SELECT sum(r.amount) FROM finance_commitment_releases r
                WHERE r.tenant_id = c.tenant_id AND r.commitment_id = c.id), 0)) AS open
        FROM finance_commitments c
       WHERE c.purchase_order_id = ${order.id}::uuid AND c.closed_at IS NULL`;
    return {
      order,
      vendorName: vendor.name,
      lines: lines.map((line) => ({
        line,
        accepted: progress.get(line.id)?.accepted ?? zero,
        rejected: progress.get(line.id)?.rejected ?? zero,
        invoiced: progress.get(line.id)?.invoiced ?? zero,
      })),
      revisions,
      receipts,
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        total: i.total.toFixed(2),
      })),
      committed: new Prisma.Decimal(committed?.open ?? 0),
      raisedByMe: order.raisedById === this.ctx.accountId,
      viewerId: this.ctx.accountId,
    };
  }
}

function totalsOf(lines: readonly LineSnapshot[]) {
  return orderTotals(
    lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxCode: l.taxCode,
    })),
  );
}

function lineData(l: LineSnapshot) {
  const net = lineNet(l.quantity, l.unitPrice);
  return {
    kind: l.kind,
    stockItemId: l.stockItemId,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unitPrice: l.unitPrice,
    taxCode: l.taxCode,
    taxRate: l.taxCode === 'vat_14' ? 14 : 0,
    withholdingCategory: l.withholdingCategory,
    net: net.toFixed(2),
    tax: lineVat(net, l.taxCode).toFixed(2),
  };
}
