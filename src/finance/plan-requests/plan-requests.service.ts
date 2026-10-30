import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type InstalmentPlanRequest } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { FinanceAccess } from '../access';
import { formatNumber } from '../counters';
import { dbNow } from '../db-clock';
import type { ConvertToInstalmentsDto } from '../instalments/dto/instalments.dto';
import {
  checkInstalmentShape,
  InstalmentsService,
} from '../instalments/instalments.service';
import { balancesOf, disputedAmong } from '../invoices/balances';
import { invoiceDisputed, invoiceNotFound } from '../invoices/invoices.service';
import { ZERO } from '../money';
import { FinanceNotices } from '../notices/finance-notices';

export const PLAN_REQUEST_RESOURCE = 'plan_request';

/**
 * What a request reads as (ADR 0069): its stored status, or `lapsed` while
 * pending on an invoice that no longer owes or was split meanwhile.
 */
export const PLAN_REQUEST_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'withdrawn',
  'lapsed',
] as const;
export type PlanRequestStatus = (typeof PLAN_REQUEST_STATUSES)[number];

export interface PlanRequestRead {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  unitId: string;
  months: number;
  status: PlanRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  declineReason: string | null;
  planId: string | null;
}

const notFound = () =>
  appError.notFound(ErrorCode.PLAN_REQUEST_NOT_FOUND, 'Plan request not found');
const notPending = (status: PlanRequestStatus) =>
  appError.conflict(ErrorCode.PLAN_REQUEST_NOT_PENDING, 'Not pending', {
    params: { status },
  });
const lapsed = () =>
  appError.conflict(
    ErrorCode.PLAN_REQUEST_LAPSED,
    'The invoice no longer owes, or was split, since it was asked',
  );
const notConvertible = (reason: 'instalment' | 'has_plan' | 'nothing_owed') =>
  appError.conflict(
    ErrorCode.INVOICE_NOT_CONVERTIBLE,
    'This invoice cannot be split into instalments',
    { params: { reason } },
  );

/**
 * A payment plan a resident asks for (ADR 0069). Whoever pays a unit's
 * money (financePay) asks on an invoice it still owes, in how many months
 * (up to the compound's most); one request waits on an invoice at a time.
 * The finance staff (`finance.invoice`) accept it with the instalments they
 * set, on the very path of their own plans (ADR 0048), or decline it with
 * a reason; the requester may withdraw it while it waits.
 *
 * Locks, as every money event (ADR 0046): the caller's account FOR SHARE,
 * the unit's finance lock, then the request FOR UPDATE; the split itself
 * reads the invoice's balance under that unit lock, so a payment and an
 * acceptance never decide on the same balance at once.
 *
 * Lapsed is read, never written; so a decision re-reads the invoice under
 * that lock, and a request whose invoice no longer owes or was split is
 * neither accepted nor declined (`409 PLAN_REQUEST_LAPSED`).
 */
@Injectable()
export class PlanRequestsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: FinanceAccess,
    private readonly community: CommunityFinancePort,
    private readonly instalments: InstalmentsService,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly notices: FinanceNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PLAN_REQUEST_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const row = await tx.instalmentPlanRequest.findUniqueOrThrow({
          where: { id },
        });
        return (await this.reads(tx, [row]))[0];
      }),
    );
  }

  ask(invoiceId: string, months: number): Promise<PlanRequestRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: PLAN_REQUEST_RESOURCE, id });
      await this.access.lockSelf(tx);
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw invoiceNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        invoice.unitId,
      );
      if (!caps?.financeView) throw invoiceNotFound();
      if (!caps.financePay)
        throw appError.forbidden(ErrorCode.FORBIDDEN, 'Not allowed');
      await this.access.lockUnits(tx, [invoice.unitId]);
      const { planMaxMonths } = await tx.financeSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.txTenantId },
        select: { planMaxMonths: true },
      });
      if (months > planMaxMonths)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid request',
          {
            fields: [
              {
                field: 'months',
                code: FieldErrorCode.INVALID_VALUE,
                params: { max: planMaxMonths },
              },
            ],
          },
        );
      if (invoice.instalmentPlanId) throw notConvertible('instalment');
      if (await tx.instalmentPlan.findFirst({ where: { invoiceId } }))
        throw notConvertible('has_plan');
      if ((await disputedAmong(tx, [invoiceId])).length)
        throw invoiceDisputed();
      const balance = (await balancesOf(tx, [invoiceId])).get(invoiceId)!;
      if (balance.outstanding.lte(ZERO)) throw notConvertible('nothing_owed');
      const waiting = await tx.instalmentPlanRequest.findFirst({
        where: { invoiceId, status: 'pending' },
        select: { id: true },
      });
      if (waiting) throw pending(waiting.id);
      let row: InstalmentPlanRequest;
      try {
        row = await tx.instalmentPlanRequest.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            invoiceId,
            unitId: invoice.unitId,
            requestedById: this.ctx.accountId,
            months,
          },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        )
          throw pending(null);
        throw e;
      }
      await this.audit.record(tx, {
        action: 'plan_request.submitted',
        targetId: id,
        metadata: { unitId: invoice.unitId, invoiceId, months },
      });
      const keepers = await this.staff.holding(tx, 'finance.invoice');
      await this.notifier.notify(
        tx,
        keepers.map((k) => k.id),
        { kind: 'instalment_plan_request.submitted', params: {}, targetId: id },
      );
      return (await this.reads(tx, [row]))[0];
    });
  }

  withdraw(id: string): Promise<PlanRequestRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const row = await this.locked(tx, id);
      if (row.requestedById !== this.ctx.accountId) throw notFound();
      if (row.status !== 'pending')
        throw notPending(row.status as PlanRequestStatus);
      const now = await dbNow(tx);
      const after = await tx.instalmentPlanRequest.update({
        where: { id },
        data: { status: 'withdrawn', decidedAt: now, lastActivityAt: now },
      });
      await this.audit.record(tx, {
        action: 'plan_request.withdrawn',
        targetId: id,
        metadata: { unitId: row.unitId, invoiceId: row.invoiceId },
      });
      return (await this.reads(tx, [after]))[0];
    });
  }

  accept(id: string, dto: ConvertToInstalmentsDto): Promise<PlanRequestRead> {
    checkInstalmentShape(dto);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const row = await this.decidable(tx, id);
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: row.invoiceId },
      });
      const plan = await this.instalments.convertLocked(
        tx,
        invoice,
        dto,
        newId(),
      );
      const now = await dbNow(tx);
      const after = await tx.instalmentPlanRequest.update({
        where: { id },
        data: {
          status: 'accepted',
          decidedById: this.ctx.accountId,
          decidedAt: now,
          lastActivityAt: now,
          planId: plan.id,
        },
      });
      await this.audit.record(tx, {
        action: 'plan_request.accepted',
        targetId: id,
        metadata: {
          unitId: row.unitId,
          invoiceId: row.invoiceId,
          planId: plan.id,
        },
      });
      await this.notices.toHolder(
        tx,
        row.requestedById,
        row.unitId,
        'instalment_plan_request.accepted',
        id,
      );
      return (await this.reads(tx, [after]))[0];
    });
  }

  decline(id: string, code: string | undefined): Promise<PlanRequestRead> {
    const reasonCode = requireReasonCodeOnly(
      code,
      REASON_CODES.planRequestDecline,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const row = await this.decidable(tx, id);
      const now = await dbNow(tx);
      const after = await tx.instalmentPlanRequest.update({
        where: { id },
        data: {
          status: 'declined',
          decidedById: this.ctx.accountId,
          decidedAt: now,
          lastActivityAt: now,
          declineReason: reasonCode,
        },
      });
      await this.audit.record(tx, {
        action: 'plan_request.declined',
        targetId: id,
        metadata: { unitId: row.unitId, invoiceId: row.invoiceId, reasonCode },
      });
      const holders = await this.community.financeHolders(tx, row.unitId);
      if (holders.includes(row.requestedById))
        await this.notifier.notify(tx, [row.requestedById], {
          kind: 'instalment_plan_request.declined',
          params: { reason: reasonCode },
          targetId: id,
        });
      return (await this.reads(tx, [after]))[0];
    });
  }

  /** The requester's, or anyone's who sees the unit's money now. */
  mine(id: string): Promise<PlanRequestRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.instalmentPlanRequest.findUnique({ where: { id } });
      if (!row) throw notFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        row.unitId,
      );
      if (!caps?.financeView) throw notFound();
      return (await this.reads(tx, [row]))[0];
    });
  }

  /** The staff's queue: a status (pending by default), oldest first. */
  queue(status: PlanRequestStatus = 'pending'): Promise<PlanRequestRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.instalmentPlanRequest.findMany({
        where: { status: status === 'lapsed' ? 'pending' : status },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      return (await this.reads(tx, rows)).filter((r) => r.status === status);
    });
  }

  get(id: string): Promise<PlanRequestRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.instalmentPlanRequest.findUnique({ where: { id } });
      if (!row) throw notFound();
      return (await this.reads(tx, [row]))[0];
    });
  }

  /** The request's unit locked first (finance's lock order), then the row. */
  private async locked(
    tx: TenantTxClient,
    id: string,
  ): Promise<InstalmentPlanRequest> {
    const found = await tx.instalmentPlanRequest.findUnique({
      where: { id },
      select: { unitId: true },
    });
    if (!found) throw notFound();
    await this.access.lockUnits(tx, [found.unitId]);
    await tx.$queryRaw`
      SELECT id FROM instalment_plan_requests WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.instalmentPlanRequest.findUniqueOrThrow({ where: { id } });
  }

  /**
   * A request the staff may still decide, locked: pending, on an invoice
   * that still owes and was not split — read under the unit's finance
   * lock, which every payment, credit and split of it takes too.
   */
  private async decidable(
    tx: TenantTxClient,
    id: string,
  ): Promise<InstalmentPlanRequest> {
    const row = await this.locked(tx, id);
    if (row.status !== 'pending')
      throw notPending(row.status as PlanRequestStatus);
    if ((await doneWith(tx, [row.invoiceId])).has(row.invoiceId))
      throw lapsed();
    return row;
  }

  /** As the API reads them: a waiting request on an invoice done with reads lapsed. */
  async reads(
    tx: TenantTxClient,
    rows: InstalmentPlanRequest[],
  ): Promise<PlanRequestRead[]> {
    if (!rows.length) return [];
    const invoiceIds = [...new Set(rows.map((r) => r.invoiceId))];
    const invoices = new Map(
      (
        await tx.invoice.findMany({
          where: { id: { in: invoiceIds } },
          select: { id: true, number: true },
        })
      ).map((i) => [i.id, i]),
    );
    const done = await doneWith(tx, invoiceIds);
    return rows.map((r) => {
      const invoice = invoices.get(r.invoiceId)!;
      return {
        id: r.id,
        invoiceId: r.invoiceId,
        invoiceNumber: formatNumber('invoice', invoice.number),
        unitId: r.unitId,
        months: r.months,
        status:
          r.status === 'pending' && done.has(r.invoiceId)
            ? 'lapsed'
            : (r.status as PlanRequestStatus),
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        declineReason: r.declineReason,
        planId: r.planId,
      };
    });
  }
}

/**
 * The invoices a request no longer stands on: an instalment, split into
 * instalments, or owing nothing (paid or credited), whatever did it.
 */
async function doneWith(
  tx: TenantTxClient,
  invoiceIds: string[],
): Promise<Set<string>> {
  const invoices = await tx.invoice.findMany({
    where: { id: { in: invoiceIds } },
    select: { id: true, instalmentPlanId: true },
  });
  const split = new Set(
    (
      await tx.instalmentPlan.findMany({
        where: { invoiceId: { in: invoiceIds } },
        select: { invoiceId: true },
      })
    ).map((p) => p.invoiceId),
  );
  const balances = await balancesOf(tx, invoiceIds);
  return new Set(
    invoices
      .filter(
        (i) =>
          i.instalmentPlanId !== null ||
          split.has(i.id) ||
          !balances.get(i.id)!.outstanding.gt(ZERO),
      )
      .map((i) => i.id),
  );
}

const pending = (requestId: string | null) =>
  appError.conflict(
    ErrorCode.PLAN_REQUEST_PENDING,
    'A plan request waits on this invoice already',
    requestId ? { params: { requestId } } : {},
  );
