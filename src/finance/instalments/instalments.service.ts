import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type Invoice, type InstalmentPlan } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { addDays } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, dbNow } from '../db-clock';
import { CURRENCY, money, show, ZERO } from '../money';
import { FinanceNotices } from '../notices/finance-notices';
import { supersedeLive } from '../online/supersede';
import { allocateUnit } from '../payments/allocation';
import {
  balancesOf,
  CREDITED_SQL,
  disputedAmong,
  PAID_SQL,
} from '../invoices/balances';
import {
  invoiceDisputed,
  invoiceNotFound,
  InvoicesService,
  MAX_DUE_DAYS,
} from '../invoices/invoices.service';
import type {
  CancelInstalmentPlanDto,
  ConvertToInstalmentsDto,
  InstalmentPlanStatus,
} from './dto/instalments.dto';
import type {
  InstalmentPlanDetailView,
  InstalmentPlanView,
} from './views/instalment.views';

export const INSTALMENT_PLAN_RESOURCE = 'instalment_plan';
/** How far ahead an instalment may fall due (ADR 0048). */
export const MAX_INSTALMENT_DAYS = 730;
const MIN_INSTALMENT = money('1');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const planNotFound = () =>
  appError.notFound(
    ErrorCode.INSTALMENT_PLAN_NOT_FOUND,
    'Instalment plan not found',
  );

const notConvertible = (reason: 'instalment' | 'has_plan' | 'nothing_owed') =>
  appError.conflict(
    ErrorCode.INVOICE_NOT_CONVERTIBLE,
    'This invoice cannot be split into instalments',
    { params: { reason } },
  );

/** What is still owed on the plan's instalments, by plan, as SQL. */
const PLAN_OWED_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM invoices i
   WHERE i.tenant_id = p.tenant_id AND i.instalment_plan_id = p.id
     AND i.total - ${CREDITED_SQL} - ${PAID_SQL} > 0)`;

export interface InstalmentPlanFilter {
  unitId?: string;
  status?: InstalmentPlanStatus;
  cursor?: string;
  limit: number;
}

const cursor = keysetCursor('createdAt');

/**
 * Instalment plans (ADR 0048). Staff turn what an open invoice owes into
 * 2–24 instalment invoices; a credit note of reason `instalment_plan`
 * closes the original. The instalments are ordinary invoices: payments,
 * receipts and reminders work on them unchanged. Every write holds the
 * unit's finance lock, and numbers are taken in COUNTER_ORDER.
 */
@Injectable()
export class InstalmentsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityFinancePort,
    private readonly access: FinanceAccess,
    private readonly notices: FinanceNotices,
    private readonly invoices: InvoicesService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(INSTALMENT_PLAN_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.detailIn(
          tx,
          await tx.instalmentPlan.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /**
   * Splits what the invoice owes now into the instalments given, which must
   * add up to exactly that. One push tells the unit; the instalments are
   * never announced one by one.
   */
  convert(
    invoiceId: string,
    dto: ConvertToInstalmentsDto,
  ): Promise<InstalmentPlanDetailView> {
    const amounts = dto.instalments.map((i) => money(i.amount));
    const shape: FieldError[] = [];
    amounts.forEach((a, i) => {
      if (a.lt(MIN_INSTALMENT))
        shape.push({
          field: `instalments.${i}.amount`,
          code: FieldErrorCode.INVALID_VALUE,
          params: { min: show(MIN_INSTALMENT) },
        });
    });
    dto.instalments.forEach((inst, i) => {
      if (i > 0 && inst.dueOn <= dto.instalments[i - 1].dueOn)
        shape.push({
          field: `instalments.${i}.dueOn`,
          code: FieldErrorCode.DUE_DATES_NOT_INCREASING,
        });
    });
    if (shape.length) throw invalid(shape);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: INSTALMENT_PLAN_RESOURCE, id });
      await this.access.lockSelf(tx);
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw invoiceNotFound();
      await this.access.lockUnits(tx, [invoice.unitId]);
      const today = await this.invoices.today(tx);
      const latest = addDays(today, MAX_INSTALMENT_DAYS);
      const first = dto.instalments[0].dueOn;
      const last = dto.instalments[dto.instalments.length - 1].dueOn;
      if (first < today || last > latest)
        throw invalid([
          {
            field:
              first < today
                ? 'instalments.0.dueOn'
                : `instalments.${dto.instalments.length - 1}.dueOn`,
            code: FieldErrorCode.DUE_ON_OUT_OF_RANGE,
            params: { min: today, max: latest },
          },
        ]);
      if (invoice.instalmentPlanId) throw notConvertible('instalment');
      if ((await disputedAmong(tx, [invoiceId])).length)
        throw invoiceDisputed();
      if (await tx.instalmentPlan.findFirst({ where: { invoiceId } }))
        throw notConvertible('has_plan');
      const balance = (await balancesOf(tx, [invoiceId])).get(invoiceId)!;
      if (balance.outstanding.lte(ZERO)) throw notConvertible('nothing_owed');
      const total = amounts.reduce((sum, a) => sum.add(a), ZERO);
      if (!total.eq(balance.outstanding))
        throw appError.conflict(
          ErrorCode.INSTALMENTS_DONT_ADD_UP,
          'The instalments do not add up to what the invoice owes',
          { params: { outstanding: show(balance.outstanding) } },
        );

      const tenantId = invoice.tenantId;
      const count = amounts.length;
      // COUNTER_ORDER: the plan, its credit note, then the invoices.
      const planNumber = await takeNumbers(tx, tenantId, 'instalment_plan');
      const noteNumber = await takeNumbers(tx, tenantId, 'credit_note');
      const firstNumber = await takeNumbers(tx, tenantId, 'invoice', count);
      const plan = await tx.instalmentPlan.create({
        data: {
          id,
          tenantId,
          number: planNumber,
          unitId: invoice.unitId,
          invoiceId,
          instalmentCount: count,
          total,
          createdById: this.ctx.accountId,
        },
      });
      const note = await tx.creditNote.create({
        data: {
          id: newId(),
          tenantId,
          number: noteNumber,
          invoiceId,
          amount: total,
          reasonCode: 'instalment_plan',
          instalmentPlanId: id,
          createdById: this.ctx.accountId,
        },
      });
      const originalNumber = formatNumber('invoice', invoice.number);
      const rows = dto.instalments.map((inst, i) => ({
        batchId: newId(),
        invoiceId: newId(),
        number: firstNumber + i,
        position: i + 1,
        dueOn: inst.dueOn,
        amount: amounts[i],
      }));
      // Each instalment comes from its own one-unit batch (every invoice
      // comes from a batch), carrying its own due date.
      await tx.invoiceBatch.createMany({
        data: rows.map((r) => ({
          id: r.batchId,
          tenantId,
          target: 'unit' as const,
          unitId: invoice.unitId,
          kind: invoice.kind,
          unitCount: 1,
          issuedOn: asDate(today),
          dueOn: asDate(r.dueOn),
          createdById: this.ctx.accountId,
        })),
      });
      await tx.invoice.createMany({
        data: rows.map((r) => ({
          id: r.invoiceId,
          tenantId,
          number: r.number,
          batchId: r.batchId,
          unitId: invoice.unitId,
          kind: invoice.kind,
          total: r.amount,
          currency: CURRENCY,
          issuedOn: asDate(today),
          dueOn: asDate(r.dueOn),
          createdById: this.ctx.accountId,
          instalmentPlanId: id,
          instalmentPosition: r.position,
        })),
      });
      await tx.invoiceLine.createMany({
        data: rows.map((r) => ({
          id: newId(),
          tenantId,
          invoiceId: r.invoiceId,
          position: 1,
          descriptionEn: `Instalment ${r.position} of ${count} — ${originalNumber}`,
          descriptionAr: `القسط ${r.position} من ${count} — ${originalNumber}`,
          amount: r.amount,
        })),
      });
      // The plan announces itself once: its instalments' `issued` notices
      // are claimed here, so the minute sweep never sends them.
      await this.notices.claimSilently(
        tx,
        tenantId,
        rows.map((r) => r.invoiceId),
        'issued',
      );
      await supersedeLive(tx, [invoice.unitId]);
      // Credit the unit holds pays the first instalments at once.
      await allocateUnit(tx, tenantId, invoice.unitId);
      await this.audit.record(tx, {
        action: 'instalment_plan.created',
        targetId: id,
        metadata: {
          unitId: invoice.unitId,
          invoiceId,
          number: formatNumber('instalment_plan', planNumber),
          count,
          total: show(total),
          creditNoteId: note.id,
          firstDueOn: first,
          lastDueOn: last,
        },
      });
      await this.notices.toUnit(
        tx,
        invoice.unitId,
        'instalment_plan.created',
        id,
      );
      return this.detailIn(tx, plan);
    });
  }

  /**
   * Ends a plan: what its instalments still owe is credited off them and
   * asked for again by one remainder invoice, due on `dueOn`.
   */
  cancel(
    planId: string,
    dto: CancelInstalmentPlanDto,
  ): Promise<InstalmentPlanDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.idempotency.claim(tx, {
        type: INSTALMENT_PLAN_RESOURCE,
        id: planId,
      });
      await this.access.lockSelf(tx);
      const found = await tx.instalmentPlan.findUnique({
        where: { id: planId },
      });
      if (!found) throw planNotFound();
      await this.access.lockUnits(tx, [found.unitId]);
      const [{ id }] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM instalment_plans WHERE id = ${planId}::uuid FOR UPDATE`;
      const plan = await tx.instalmentPlan.findUniqueOrThrow({ where: { id } });
      if (plan.cancelledAt)
        throw appError.conflict(
          ErrorCode.INSTALMENT_PLAN_CLOSED,
          'The plan is closed',
          { params: { status: 'cancelled' } },
        );
      const today = await this.invoices.today(tx);
      const latest = addDays(today, MAX_DUE_DAYS);
      if (dto.dueOn < today || dto.dueOn > latest)
        throw invalid([
          {
            field: 'dueOn',
            code: FieldErrorCode.DUE_ON_OUT_OF_RANGE,
            params: { min: today, max: latest },
          },
        ]);
      const instalments = await tx.invoice.findMany({
        where: { instalmentPlanId: planId },
        orderBy: { instalmentPosition: 'asc' },
      });
      const balances = await balancesOf(
        tx,
        instalments.map((i) => i.id),
      );
      const open = instalments
        .map((i) => ({ invoice: i, owed: balances.get(i.id)!.outstanding }))
        .filter((o) => o.owed.gt(ZERO));
      if (!open.length)
        throw appError.conflict(
          ErrorCode.INSTALMENT_PLAN_CLOSED,
          'The plan is closed',
          { params: { status: 'settled' } },
        );
      // A disputed instalment waits for its decision.
      if (
        (
          await disputedAmong(
            tx,
            open.map((o) => o.invoice.id),
          )
        ).length
      )
        throw invoiceDisputed();
      const tenantId = plan.tenantId;
      const remainder = open.reduce((sum, o) => sum.add(o.owed), ZERO);
      // COUNTER_ORDER: the credit notes, then the remainder invoice.
      const firstNote = await takeNumbers(
        tx,
        tenantId,
        'credit_note',
        open.length,
      );
      const notes = open.map((o, i) => ({
        id: newId(),
        tenantId,
        number: firstNote + i,
        invoiceId: o.invoice.id,
        amount: o.owed,
        reasonCode: 'instalment_plan',
        instalmentPlanId: planId,
        createdById: this.ctx.accountId,
      }));
      await tx.creditNote.createMany({ data: notes });
      const original = await tx.invoice.findUniqueOrThrow({
        where: { id: plan.invoiceId },
        select: { kind: true },
      });
      const batchId = newId();
      const planNumber = formatNumber('instalment_plan', plan.number);
      const [unit] = await this.community.unitsFor(tx, {
        unitId: plan.unitId,
      });
      await this.invoices.issueTo(tx, {
        batchId,
        target: { unitId: plan.unitId },
        units: [unit],
        kind: original.kind,
        issuedOn: today,
        dueOn: dto.dueOn,
        lines: [
          {
            descriptionEn: `Remainder of instalment plan ${planNumber}`,
            descriptionAr: `المتبقي من خطة التقسيط ${planNumber}`,
            amount: remainder,
          },
        ],
        createdById: this.ctx.accountId,
      });
      const remainderInvoice = await tx.invoice.findFirstOrThrow({
        where: { batchId },
        select: { id: true },
      });
      const cancelled = await tx.instalmentPlan.update({
        where: { id: planId },
        data: {
          cancelledAt: await dbNow(tx),
          cancelledById: this.ctx.accountId,
          remainderInvoiceId: remainderInvoice.id,
        },
      });
      await supersedeLive(tx, [plan.unitId]);
      await allocateUnit(tx, tenantId, plan.unitId);
      await this.audit.record(tx, {
        action: 'instalment_plan.cancelled',
        targetId: planId,
        metadata: {
          unitId: plan.unitId,
          remainder: show(remainder),
          remainderInvoiceId: remainderInvoice.id,
          creditNoteIds: notes.map((n) => n.id),
        },
      });
      return this.detailIn(tx, cancelled);
    });
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** The staff's list, newest first. */
  list(filter: InstalmentPlanFilter): Promise<Page<InstalmentPlanView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
      if (filter.unitId)
        conds.push(Prisma.sql`p.unit_id = ${filter.unitId}::uuid`);
      if (filter.status === 'cancelled')
        conds.push(Prisma.sql`p.cancelled_at IS NOT NULL`);
      if (filter.status === 'active')
        conds.push(Prisma.sql`p.cancelled_at IS NULL AND ${PLAN_OWED_SQL}`);
      if (filter.status === 'settled')
        conds.push(Prisma.sql`p.cancelled_at IS NULL AND NOT ${PLAN_OWED_SQL}`);
      if (filter.cursor) {
        const c = cursor.decode(filter.cursor);
        conds.push(Prisma.sql`(p.created_at, p.id) < (${c.at}, ${c.id}::uuid)`);
      }
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM instalment_plans p
         WHERE ${Prisma.join(conds, ' AND ')}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ${filter.limit + 1}`;
      const plans = await tx.instalmentPlan.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const page = cursor.toPage(plans, filter.limit);
      const views = await this.views(tx, page.items);
      return { items: views.map((v) => v.plan), nextCursor: page.nextCursor };
    });
  }

  /** One plan, for the staff. */
  detail(id: string): Promise<InstalmentPlanDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const plan = await tx.instalmentPlan.findUnique({ where: { id } });
      if (!plan) throw planNotFound();
      return this.detailIn(tx, plan);
    });
  }

  /** One plan, for someone who sees its unit's money; else not found. */
  mine(id: string): Promise<InstalmentPlanDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const plan = await tx.instalmentPlan.findUnique({ where: { id } });
      if (!plan) throw planNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        plan.unitId,
      );
      if (!caps?.financeView) throw planNotFound();
      return this.detailIn(tx, plan);
    });
  }

  private async detailIn(
    tx: TenantTxClient,
    plan: InstalmentPlan,
  ): Promise<InstalmentPlanDetailView> {
    const [view] = await this.views(tx, [plan]);
    const today = await this.invoices.today(tx);
    const invoiceViews = await this.invoices.views(tx, view.instalments, today);
    return {
      ...view.plan,
      instalments: invoiceViews.map((v, i) => ({
        ...v,
        position: view.instalments[i].instalmentPosition!,
      })),
    };
  }

  /** Plans with their computed outstanding and status, in one pass. */
  private async views(
    tx: TenantTxClient,
    plans: readonly InstalmentPlan[],
  ): Promise<{ plan: InstalmentPlanView; instalments: Invoice[] }[]> {
    if (!plans.length) return [];
    const ids = plans.map((p) => p.id);
    const instalments = await tx.invoice.findMany({
      where: { instalmentPlanId: { in: ids } },
      orderBy: [{ instalmentPlanId: 'asc' }, { instalmentPosition: 'asc' }],
    });
    const related = await tx.invoice.findMany({
      where: {
        id: {
          in: plans.flatMap((p) =>
            p.remainderInvoiceId
              ? [p.invoiceId, p.remainderInvoiceId]
              : [p.invoiceId],
          ),
        },
      },
      select: { id: true, number: true },
    });
    const numbers = new Map(related.map((r) => [r.id, r.number]));
    const balances = await balancesOf(
      tx,
      instalments.map((i) => i.id),
    );
    const units = await this.community.units(
      tx,
      plans.map((p) => p.unitId),
    );
    return plans.map((p) => {
      const own = instalments.filter((i) => i.instalmentPlanId === p.id);
      const outstanding = own.reduce(
        (sum, i) => sum.add(balances.get(i.id)!.outstanding),
        ZERO,
      );
      const status: InstalmentPlanStatus = p.cancelledAt
        ? 'cancelled'
        : outstanding.gt(ZERO)
          ? 'active'
          : 'settled';
      return {
        instalments: own,
        plan: {
          id: p.id,
          number: formatNumber('instalment_plan', p.number),
          unitId: p.unitId,
          unitCode: units.get(p.unitId)?.code ?? '',
          invoiceId: p.invoiceId,
          invoiceNumber: formatNumber('invoice', numbers.get(p.invoiceId)!),
          instalmentCount: p.instalmentCount,
          total: show(p.total),
          outstanding: show(outstanding),
          status,
          createdAt: p.createdAt,
          cancelledAt: p.cancelledAt,
          remainderInvoiceId: p.remainderInvoiceId,
          remainderInvoiceNumber: p.remainderInvoiceId
            ? formatNumber('invoice', numbers.get(p.remainderInvoiceId)!)
            : null,
        },
      };
    });
  }
}
