import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PurchaseRequest } from '@prisma/client';
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
import { PayablesBridge } from '../../core/payables/payables-bridge';
import { dbNow } from '../db-clock';
import { claimApproval } from './approval-claims';
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
import { purchaseReference, type PurchaseStatus } from './purchase-rules';

export const PURCHASE_RESOURCE = 'purchase_request';

export interface NewPurchaseRequest {
  title: string;
  description?: string;
  vendorId?: string;
  budgetLineId?: string;
  stockItemId?: string;
  quantity?: string;
  estimatedAmount: string;
  neededBy?: LocalDate;
}

export interface PurchaseRead {
  request: PurchaseRequest;
  /** The caller asked for it. */
  mine: boolean;
}

const PAGE = keysetCursor('requestedAt');

const notFound = () =>
  appError.notFound(
    ErrorCode.PURCHASE_REQUEST_NOT_FOUND,
    'Purchase request not found',
  );
const wrongStatus = (status: string) =>
  appError.conflict(
    ErrorCode.PURCHASE_REQUEST_WRONG_STATUS,
    'The purchase request is not in a state that allows this',
    { params: { status } },
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid purchase request', {
    fields,
  });
const approvalInvalid = (
  reason: 'not_approved' | 'below_amount' | 'covers_another',
) =>
  appError.conflict(
    ErrorCode.PURCHASE_APPROVAL_INVALID,
    'That approval cannot cover this request',
    { params: { reason } },
  );

/**
 * Light purchase requests (ADR 0077): the staff who need a part, a supply
 * or a service the compound lacks ask for it (`purchases.request`); the
 * manager approves (`purchases.approve`) up to the manager's limit, the
 * major contract threshold of ADR 0055, and above it only under the board's
 * approved major contract of at least the amount, which covers one request
 * or one contract. Its requester never approves it (PURCHASE_SELF_APPROVAL):
 * another approver does, a live deputy among them (ADR 0073), or, naming
 * the board's approval, the board has. No purchase order: once bought, the approver marks it
 * fulfilled with the reference of what paid it. A requester sees their own;
 * an approver sees all. The title and description are words about work.
 *
 * Forward only (a trigger): requested → approved | rejected | cancelled;
 * approved → fulfilled | cancelled. Decided under the request's lock, by
 * what is read after it.
 *
 * Locks: the request (update) → the vendor (shared) → the threshold's row
 * (shared) → the approval request (shared) → the counter.
 */
@Injectable()
export class PurchasesService implements OnModuleInit {
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
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PURCHASE_RESOURCE, (id) => this.get(id));
  }

  /** Newest first; a requester's own only unless they approve. */
  async list(q: {
    status?: PurchaseStatus;
    mine?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<Page<PurchaseRead>> {
    const limit = clampLimit(q.limit);
    const all = await this.permissions.has('purchases.approve');
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.purchaseRequest.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            !all || q.mine ? { requestedById: this.ctx.accountId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: page.items.map((r) => this.read(r)) };
    });
  }

  async get(id: string): Promise<PurchaseRead> {
    const all = await this.permissions.has('purchases.approve');
    return this.tenantTx.withTenantTx(async (tx) => {
      const r = await tx.purchaseRequest.findUnique({ where: { id } });
      if (!r || (!all && r.requestedById !== this.ctx.accountId))
        throw notFound();
      return this.read(r);
    });
  }

  submit(input: NewPurchaseRequest): Promise<PurchaseRead> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const id = newId();
        await this.idempotency.claim(tx, { type: PURCHASE_RESOURCE, id });
        const { today } = await this.calendar.now(tx);
        const fields: FieldError[] = [];
        if (input.neededBy && input.neededBy < today)
          fields.push({
            field: 'neededBy',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { min: today },
          });
        if (
          (input.stockItemId === undefined) !==
          (input.quantity === undefined)
        )
          fields.push({
            field: input.stockItemId ? 'quantity' : 'stockItemId',
            code: FieldErrorCode.FIELD_REQUIRED,
          });
        if (fields.length) throw invalid(fields);
        if (input.vendorId) await this.vendors.lockUsable(tx, input.vendorId);
        if (
          input.budgetLineId &&
          !(await tx.financeBudgetLine.findUnique({
            where: { id: input.budgetLineId },
          }))
        )
          throw invalid([
            {
              field: 'budgetLineId',
              code: FieldErrorCode.BUDGET_LINE_NOT_AVAILABLE,
            },
          ]);
        if (input.stockItemId) {
          const item = await tx.stockItem.findUnique({
            where: { id: input.stockItemId },
            select: { active: true },
          });
          if (!item?.active)
            throw invalid([
              {
                field: 'stockItemId',
                code: FieldErrorCode.STOCK_ITEM_NOT_AVAILABLE,
              },
            ]);
        }
        const number = await nextProcurementNumber(
          tx,
          this.ctx.tenantId,
          'purchase_request',
        );
        const request = await tx.purchaseRequest.create({
          data: {
            id,
            tenantId: this.ctx.tenantId,
            number,
            title: input.title.trim(),
            description: input.description?.trim() || null,
            vendorId: input.vendorId ?? null,
            budgetLineId: input.budgetLineId ?? null,
            stockItemId: input.stockItemId ?? null,
            quantity: input.quantity ?? null,
            estimatedAmount: input.estimatedAmount,
            neededBy: input.neededBy ? dateColumn(input.neededBy) : null,
            requestedById: this.ctx.accountId,
            requestedAt: await dbNow(tx),
          },
        });
        await this.audit.record(tx, {
          action: 'purchase_request.submitted',
          targetId: id,
          changes: {
            title: { changed: true },
            ...(request.description ? { description: { changed: true } } : {}),
          },
          metadata: {
            number,
            estimatedAmount: request.estimatedAmount.toFixed(2),
            vendorId: request.vendorId,
            budgetLineId: request.budgetLineId,
            stockItemId: request.stockItemId,
          },
        });
        const approvers = (
          await this.staff.holding(tx, 'purchases.approve')
        ).filter((a) => a.id !== this.ctx.accountId);
        await this.notifier.notify(
          tx,
          approvers.map((a) => a.id),
          {
            kind: 'purchase_request.submitted',
            params: {
              requestRef: purchaseReference(number),
              amount: request.estimatedAmount.toFixed(2),
            },
            targetId: id,
          },
        );
        return id;
      })
      .then((id) => this.get(id));
  }

  /**
   * Approved by the manager up to the limit; above it, under the board's
   * approved major contract of at least the amount, covering no other
   * request or contract. Its vendor must not have been suspended since.
   */
  approve(
    id: string,
    input: { approvalRequestId?: string; note?: string },
  ): Promise<PurchaseRead> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'requested') throw wrongStatus(before.status);
        // Nobody approves their own request (owner, 2026-11-02): another
        // approver does (a live deputy too), or the board's approval named.
        if (
          before.requestedById === this.ctx.accountId &&
          !input.approvalRequestId
        )
          throw appError.conflict(
            ErrorCode.PURCHASE_SELF_APPROVAL,
            'You asked for this purchase: another approver decides it',
          );
        if (before.vendorId) await this.vendors.lockUsable(tx, before.vendorId);
        const approvalRequestId = await this.coveredBy(
          tx,
          before,
          input.approvalRequestId ?? null,
        );
        // Approved, it keeps its line's budget until invoiced or called
        // off (ADR 0089): refused when the line has not that much left.
        if (before.budgetLineId)
          await this.payables.commitments.sync(tx, {
            source: 'purchase_request',
            sourceId: id,
            items: [
              {
                itemId: id,
                lineId: before.budgetLineId,
                amount: before.estimatedAmount.toFixed(2),
                dueOn: before.neededBy ? ofDateColumn(before.neededBy) : null,
                vendorId: before.vendorId,
              },
            ],
            reason: 'changed',
          });
        await tx.purchaseRequest.update({
          where: { id },
          data: {
            status: 'approved',
            decidedById: this.ctx.accountId,
            decidedAt: await dbNow(tx),
            decisionNote: input.note?.trim() || null,
            approvalRequestId,
          },
        });
        await this.audit.record(tx, {
          action: 'purchase_request.approved',
          targetId: id,
          metadata: { approvalRequestId },
          ...(input.note?.trim()
            ? { changes: { decisionNote: { changed: true } } }
            : {}),
        });
        await this.tell(tx, before, 'approved');
      })
      .then(() => this.get(id));
  }

  reject(
    id: string,
    input: { reasonCode?: string; note?: string },
  ): Promise<PurchaseRead> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.purchaseReject,
    );
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'requested') throw wrongStatus(before.status);
        await tx.purchaseRequest.update({
          where: { id },
          data: {
            status: 'rejected',
            decidedById: this.ctx.accountId,
            decidedAt: await dbNow(tx),
            rejectReason: reason,
            decisionNote: input.note?.trim() || null,
          },
        });
        await this.audit.record(tx, {
          action: 'purchase_request.rejected',
          targetId: id,
          metadata: { reasonCode: reason },
          ...(input.note?.trim()
            ? { changes: { decisionNote: { changed: true } } }
            : {}),
        });
        await this.tell(tx, before, 'rejected');
      })
      .then(() => this.get(id));
  }

  /** By its requester or an approver, before it is fulfilled. */
  async cancel(id: string, reasonCode?: string): Promise<PurchaseRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.purchaseCancel,
    );
    const all = await this.permissions.has('purchases.approve');
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (!all && before.requestedById !== this.ctx.accountId)
          throw notFound();
        if (before.status !== 'requested' && before.status !== 'approved')
          throw wrongStatus(before.status);
        await tx.purchaseRequest.update({
          where: { id },
          data: {
            status: 'cancelled',
            cancelledById: this.ctx.accountId,
            cancelledAt: await dbNow(tx),
            cancelReason: reason,
          },
        });
        if (before.status === 'approved')
          await this.payables.commitments.sync(tx, {
            source: 'purchase_request',
            sourceId: id,
            items: [],
            reason: 'cancelled',
          });
        await this.audit.record(tx, {
          action: 'purchase_request.cancelled',
          targetId: id,
          metadata: { reasonCode: reason, from: before.status },
        });
      })
      .then(() => this.get(id));
  }

  /** Bought: approved, then fulfilled once, with what paid it. */
  fulfil(id: string, reference?: string): Promise<PurchaseRead> {
    return this.tenantTx
      .withTenantTx(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.status !== 'approved') throw wrongStatus(before.status);
        await tx.purchaseRequest.update({
          where: { id },
          data: {
            status: 'fulfilled',
            fulfilledById: this.ctx.accountId,
            fulfilledAt: await dbNow(tx),
            fulfilledReference: reference?.trim() || null,
          },
        });
        await this.audit.record(tx, {
          action: 'purchase_request.fulfilled',
          targetId: id,
          metadata: { reference: reference?.trim() || null },
        });
      })
      .then(() => this.get(id));
  }

  /** The approval it is covered by, or null within the manager's limit. */
  private async coveredBy(
    tx: TenantTxClient,
    r: PurchaseRequest,
    approvalRequestId: string | null,
  ): Promise<string | null> {
    const limit = await this.matters.threshold(tx, 'major_contract');
    if (approvalRequestId) {
      const a = await this.matters.approvalRequest(tx, approvalRequestId);
      if (!a || a.type !== 'major_contract' || a.status !== 'approved')
        throw approvalInvalid('not_approved');
      if (a.cost !== null && new Prisma.Decimal(r.estimatedAmount).gt(a.cost))
        throw approvalInvalid('below_amount');
      // One claim of an approval at a time, by a contract or a purchase
      // request (two tables, no unique index across them).
      await claimApproval(tx, this.ctx.txTenantId, approvalRequestId);
      const other =
        (await tx.purchaseRequest.findFirst({
          where: { approvalRequestId, NOT: { id: r.id } },
          select: { id: true },
        })) ??
        (await tx.maintenanceContract.findFirst({
          where: { approvalRequestId },
          select: { id: true },
        }));
      if (other) throw approvalInvalid('covers_another');
      return approvalRequestId;
    }
    if (limit !== null && new Prisma.Decimal(r.estimatedAmount).gt(limit))
      throw appError.conflict(
        ErrorCode.PURCHASE_NEEDS_APPROVAL,
        'Above the manager’s limit: the board approves it as a major contract',
        { params: { threshold: limit } },
      );
    return null;
  }

  /** The requester is told the decision, unless they decided it. */
  private async tell(
    tx: TenantTxClient,
    r: PurchaseRequest,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    if (r.requestedById === this.ctx.accountId) return;
    await this.notifier.notify(tx, [r.requestedById], {
      kind: 'purchase_request.decided',
      params: { requestRef: purchaseReference(r.number), decision },
      targetId: r.id,
    });
  }

  private async lock(tx: TenantTxClient, id: string): Promise<PurchaseRequest> {
    await tx.$queryRaw`SELECT id FROM purchase_requests WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await tx.purchaseRequest.findUnique({ where: { id } });
    if (!r) throw notFound();
    return r;
  }

  private read(r: PurchaseRequest): PurchaseRead {
    return { request: r, mine: r.requestedById === this.ctx.accountId };
  }
}
