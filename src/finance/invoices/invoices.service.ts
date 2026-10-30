import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type Invoice } from '@prisma/client';
import { CommunityFinancePort, type FinanceUnit } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, fromDate, localToday } from '../db-clock';
import { CURRENCY, MAX_AMOUNT, money, show, ZERO } from '../money';
import { FinanceNotices } from '../notices/finance-notices';
import { supersedeLive } from '../online/supersede';
import {
  allocateUnit,
  allocateUnits,
  releaseNewest,
} from '../payments/allocation';
import {
  balancesOf,
  CREDITED_SQL,
  disputedAmong,
  filterSql,
  PAID_SQL,
  RESCHEDULED_SQL,
  statusOf,
  type Balance,
  type InvoiceFilter,
} from './balances';
import type { CreditNoteDto, IssueInvoicesDto } from './dto/invoices.dto';
import type {
  CreditNoteView,
  InvoiceBatchView,
  InvoiceDetailView,
  InvoiceView,
} from './views/invoice.views';

export const INVOICE_BATCH_RESOURCE = 'invoice_batch';
export const CREDIT_NOTE_RESOURCE = 'credit_note';
/** More units than this is not one issue (ADR 0046). */
export const MAX_BATCH_UNITS = 3000;
/** Up to this many invoices are announced at once; more, by the sweep. */
export const NOTIFY_INLINE_MAX = 50;
/** How far ahead a due date may be. */
export const MAX_DUE_DAYS = 366;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const invoiceNotFound = () =>
  appError.notFound(ErrorCode.INVOICE_NOT_FOUND, 'Invoice not found');

/** The invoice is frozen by an open dispute (ADR 0048). */
export const invoiceDisputed = () =>
  appError.conflict(ErrorCode.INVOICE_DISPUTED, 'Under an open dispute');

const unitNotFound = () =>
  appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');

export interface InvoiceListFilter {
  status?: InvoiceFilter;
  kind?: Invoice['kind'];
  unitId?: string;
  building?: string;
  batchId?: string;
  planId?: string;
  cursor?: string;
  limit: number;
}

const cursor = keysetCursor('createdAt');

/**
 * A unit's invoices (ADR 0046): issued in batches (one unit, a building,
 * every unit), immutable, corrected by credit notes; what is owed is
 * computed. Every write holds the finance locks (FinanceAccess) for the
 * units it touches, so two writers never decide on one balance.
 */
@Injectable()
export class InvoicesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly community: CommunityFinancePort,
    private readonly access: FinanceAccess,
    private readonly notices: FinanceNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(INVOICE_BATCH_RESOURCE, (id) => this.batch(id));
    this.idempotency.renderer(CREDIT_NOTE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const [view] = await creditNoteViews(tx, [
          await tx.creditNote.findUniqueOrThrow({ where: { id } }),
        ]);
        return view;
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /**
   * The same invoice to every unit of the target, each its own number, in
   * one transaction. An Idempotency-Key replays the same batch.
   */
  issue(dto: IssueInvoicesDto): Promise<InvoiceBatchView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const batchId = newId();
      await this.idempotency.claim(tx, {
        type: INVOICE_BATCH_RESOURCE,
        id: batchId,
      });
      await this.access.lockSelf(tx);
      const target = issueTarget(dto);
      const total = dto.lines.reduce((sum, l) => sum.add(l.amount), ZERO);
      if (total.gt(MAX_AMOUNT))
        throw invalid([
          {
            field: 'lines',
            code: FieldErrorCode.INVOICE_TOTAL_TOO_LARGE,
            params: { max: show(MAX_AMOUNT) },
          },
        ]);
      const today = await this.today(tx);
      const latest = addDays(today, MAX_DUE_DAYS);
      if (dto.dueOn < today || dto.dueOn > latest)
        throw invalid([
          {
            field: 'dueOn',
            code: FieldErrorCode.DUE_ON_OUT_OF_RANGE,
            params: { min: today, max: latest },
          },
        ]);
      if (target !== 'all' && 'unitId' in target) {
        await this.access.lockUnits(tx, [target.unitId]);
      } else {
        await this.access.lockCompound(tx);
      }
      const units = await this.community.unitsFor(tx, target);
      if (target !== 'all' && 'unitId' in target && !units.length)
        throw unitNotFound();
      if (!units.length)
        throw appError.unprocessable(
          ErrorCode.INVOICE_BATCH_EMPTY,
          'No unit matches the target',
        );
      if (units.length > MAX_BATCH_UNITS)
        throw appError.unprocessable(
          ErrorCode.INVOICE_BATCH_TOO_LARGE,
          'Too many units for one issue',
          { params: { max: MAX_BATCH_UNITS } },
        );
      return this.issueTo(tx, {
        batchId,
        target,
        units,
        kind: dto.kind,
        dueOn: dto.dueOn,
        issuedOn: today,
        lines: dto.lines.map((l) => ({
          descriptionEn: l.descriptionEn,
          descriptionAr: l.descriptionAr,
          amount: money(l.amount),
        })),
        createdById: this.ctx.accountId,
      });
    });
  }

  /**
   * Writes one batch's invoices and lines under locks the caller holds,
   * audits it and announces small ones (the sweep announces the rest).
   * Shared with the billing plans' sweep, which names its plan and period.
   */
  async issueTo(
    tx: TenantTxClient,
    input: {
      batchId: string;
      target: { unitId: string } | { building: string } | 'all';
      units: readonly FinanceUnit[];
      kind: Invoice['kind'];
      issuedOn: LocalDate;
      dueOn: LocalDate;
      lines: {
        descriptionEn: string;
        descriptionAr: string;
        amount: Prisma.Decimal;
      }[];
      createdById: string | null;
      plan?: { id: string; period: { start: LocalDate; end: LocalDate } };
    },
  ): Promise<InvoiceBatchView> {
    const tenantId = this.ctx.txTenantId;
    const total = input.lines.reduce((sum, l) => sum.add(l.amount), ZERO);
    const first = await takeNumbers(
      tx,
      tenantId,
      'invoice',
      input.units.length,
    );
    const kind =
      input.target === 'all'
        ? 'all'
        : 'unitId' in input.target
          ? 'unit'
          : 'building';
    const batch = await tx.invoiceBatch.create({
      data: {
        id: input.batchId,
        tenantId,
        target: kind,
        unitId:
          input.target !== 'all' && 'unitId' in input.target
            ? input.target.unitId
            : null,
        building:
          input.target !== 'all' && 'building' in input.target
            ? input.target.building
            : null,
        kind: input.kind,
        unitCount: input.units.length,
        issuedOn: asDate(input.issuedOn),
        dueOn: asDate(input.dueOn),
        createdById: input.createdById,
        planId: input.plan?.id ?? null,
        periodStartsOn: input.plan ? asDate(input.plan.period.start) : null,
      },
    });
    const invoices = input.units.map((u, i) => ({
      id: newId(),
      tenantId,
      number: first + i,
      batchId: batch.id,
      unitId: u.id,
      kind: input.kind,
      total,
      currency: CURRENCY,
      issuedOn: asDate(input.issuedOn),
      dueOn: asDate(input.dueOn),
      createdById: input.createdById,
      planId: input.plan?.id ?? null,
      periodStartsOn: input.plan ? asDate(input.plan.period.start) : null,
      periodEndsOn: input.plan ? asDate(input.plan.period.end) : null,
    }));
    await tx.invoice.createMany({ data: invoices });
    await tx.invoiceLine.createMany({
      data: invoices.flatMap((inv) =>
        input.lines.map((l, i) => ({
          id: newId(),
          tenantId,
          invoiceId: inv.id,
          position: i + 1,
          descriptionEn: l.descriptionEn,
          descriptionAr: l.descriptionAr,
          amount: l.amount,
        })),
      ),
    });
    // A unit holding credit pays its new invoice with it at once.
    await allocateUnits(
      tx,
      tenantId,
      input.units.map((u) => u.id),
    );
    const last = first + input.units.length - 1;
    await this.audit.record(tx, {
      action: 'invoice_batch.issued',
      targetId: batch.id,
      metadata: {
        target: kind,
        ...(kind === 'unit' ? { unitId: batch.unitId } : {}),
        ...(input.plan
          ? { planId: input.plan.id, periodStartsOn: input.plan.period.start }
          : {}),
        unitCount: input.units.length,
        kind: input.kind,
        total: show(total),
        issuedOn: input.issuedOn,
        dueOn: input.dueOn,
        firstNumber: formatNumber('invoice', first),
        lastNumber: formatNumber('invoice', last),
      },
    });
    if (invoices.length <= NOTIFY_INLINE_MAX) {
      for (const inv of invoices)
        await this.notices.invoiceNotice(tx, tenantId, inv, 'issued');
    }
    return batchView(batch, total, first, last);
  }

  /**
   * A credit note: at most what credit notes have not yet taken off the
   * invoice. Beyond what it still owes, it releases paid money to the unit's
   * credit (ADR 0048).
   */
  credit(invoiceId: string, dto: CreditNoteDto): Promise<CreditNoteView> {
    const reasonCode = requireReasonCodeOnly(
      dto.reasonCode,
      REASON_CODES.creditNote,
    );
    // A compensation says why (ADR 0058); no other credit note does.
    const compensationReason =
      reasonCode === 'compensation'
        ? requireCompensationReason(dto.compensationReasonCode)
        : null;
    if (!compensationReason && dto.compensationReasonCode !== undefined)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Only a compensation has a compensation reason',
        {
          fields: [
            {
              field: 'compensationReasonCode',
              code: FieldErrorCode.FIELD_NOT_ALLOWED,
            },
          ],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CREDIT_NOTE_RESOURCE, id });
      await this.access.lockSelf(tx);
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw invoiceNotFound();
      await this.access.lockUnits(tx, [invoice.unitId]);
      // A disputed invoice is credited only by its dispute's decision.
      if ((await disputedAmong(tx, [invoiceId])).length)
        throw invoiceDisputed();
      const { note, released } = await creditInvoice(tx, {
        id,
        tenantId: invoice.tenantId,
        invoiceId,
        amount: money(dto.amount),
        reasonCode,
        compensationReason,
        createdById: this.ctx.accountId,
      });
      await supersedeLive(tx, [invoice.unitId]);
      // Released money pays the unit's other open invoices at once.
      if (released.gt(ZERO))
        await allocateUnit(tx, invoice.tenantId, invoice.unitId);
      await this.audit.record(tx, {
        action: 'credit_note.created',
        targetId: id,
        metadata: {
          invoiceId,
          unitId: invoice.unitId,
          number: formatNumber('credit_note', note.number),
          amount: show(note.amount),
          released: show(released),
          reasonCode,
          ...(compensationReason ? { compensationReason } : {}),
        },
      });
      // The unit is told (ADR 0058): the code, never the amount.
      await this.notices.toUnit(
        tx,
        invoice.unitId,
        compensationReason ? 'compensation.granted' : 'credit_note.issued',
        invoiceId,
        { reason: compensationReason ?? reasonCode },
      );
      return creditNoteView({ ...note, released });
    });
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** The staff's list, newest first. */
  list(filter: InvoiceListFilter): Promise<Page<InvoiceView>> {
    return this.tenantTx.withTenantTx((tx) => this.listIn(tx, filter));
  }

  /** A unit's invoices, for someone who sees its money. */
  forUnit(
    unitId: string,
    filter: Pick<InvoiceListFilter, 'status' | 'cursor' | 'limit'>,
  ): Promise<Page<InvoiceView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.assertSees(tx, unitId);
      return this.listIn(tx, { ...filter, unitId });
    });
  }

  /** One invoice, for the staff. */
  detail(id: string): Promise<InvoiceDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (!invoice) throw invoiceNotFound();
      return this.detailIn(tx, invoice);
    });
  }

  /** One invoice, for someone who sees its unit's money; else not found. */
  mine(id: string): Promise<InvoiceDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (!invoice) throw invoiceNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        invoice.unitId,
      );
      if (!caps?.financeView) throw invoiceNotFound();
      return this.detailIn(tx, invoice);
    });
  }

  batch(id: string): Promise<InvoiceBatchView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const batch = await tx.invoiceBatch.findUnique({ where: { id } });
      if (!batch)
        throw appError.notFound(
          ErrorCode.INVOICE_BATCH_NOT_FOUND,
          'Invoice batch not found',
        );
      const range = await tx.invoice.aggregate({
        where: { batchId: id },
        _min: { number: true },
        _max: { number: true },
      });
      const one = await tx.invoice.findFirstOrThrow({
        where: { batchId: id },
        select: { total: true },
      });
      return batchView(
        batch,
        one.total,
        range._min.number!,
        range._max.number!,
      );
    });
  }

  /** 404 without a place on the unit, 403 without its money. */
  async assertSees(tx: TenantTxClient, unitId: string): Promise<void> {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps?.unitView) throw unitNotFound();
    if (!caps.financeView)
      throw appError.forbidden(ErrorCode.FORBIDDEN, 'Not allowed');
  }

  async today(tx: TenantTxClient): Promise<LocalDate> {
    const settings = await this.tenantSettings.inTx(tx, this.ctx.txTenantId);
    return localToday(tx, settings.timezone);
  }

  private async listIn(
    tx: TenantTxClient,
    filter: InvoiceListFilter,
  ): Promise<Page<InvoiceView>> {
    const today = await this.today(tx);
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (filter.kind)
      conds.push(Prisma.sql`i.kind = ${filter.kind}::invoice_kind`);
    if (filter.unitId)
      conds.push(Prisma.sql`i.unit_id = ${filter.unitId}::uuid`);
    if (filter.batchId)
      conds.push(Prisma.sql`i.batch_id = ${filter.batchId}::uuid`);
    if (filter.planId)
      conds.push(Prisma.sql`i.plan_id = ${filter.planId}::uuid`);
    if (filter.building)
      conds.push(
        Prisma.sql`i.unit_id IN (SELECT u.id FROM units u WHERE u.building = ${filter.building})`,
      );
    if (filter.cursor) {
      const c = cursor.decode(filter.cursor);
      conds.push(Prisma.sql`(i.created_at, i.id) < (${c.at}, ${c.id}::uuid)`);
    }
    const status = filter.status
      ? filterSql(filter.status, today)
      : Prisma.sql`TRUE`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH b AS (
        SELECT i.id, i.created_at, i.total, i.due_on,
               ${CREDITED_SQL} AS credited, ${PAID_SQL} AS paid,
               ${RESCHEDULED_SQL} AS rescheduled
          FROM invoices i
         WHERE ${Prisma.join(conds, ' AND ')}
      )
      SELECT b.id FROM b
       WHERE ${status}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT ${filter.limit + 1}`;
    const ids = rows.map((r) => r.id);
    const invoices = await tx.invoice.findMany({
      where: { id: { in: ids } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const page = cursor.toPage(invoices, filter.limit);
    const views = await this.views(tx, page.items, today);
    return { items: views, nextCursor: page.nextCursor };
  }

  async views(
    tx: TenantTxClient,
    invoices: readonly Invoice[],
    today: LocalDate,
  ): Promise<InvoiceView[]> {
    const balances = await balancesOf(
      tx,
      invoices.map((i) => i.id),
    );
    const units = await this.community.units(
      tx,
      invoices.map((i) => i.unitId),
    );
    return invoices.map((i) =>
      invoiceView(
        i,
        units.get(i.unitId)?.code ?? '',
        balances.get(i.id)!,
        today,
      ),
    );
  }

  private async detailIn(
    tx: TenantTxClient,
    invoice: Invoice,
  ): Promise<InvoiceDetailView> {
    const today = await this.today(tx);
    const [view] = await this.views(tx, [invoice], today);
    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { position: 'asc' },
    });
    const notes = await tx.creditNote.findMany({
      where: { invoiceId: invoice.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const instalmentOf = invoice.instalmentPlanId
      ? await tx.instalmentPlan.findUniqueOrThrow({
          where: { id: invoice.instalmentPlanId },
          select: { id: true, number: true, instalmentCount: true },
        })
      : null;
    const rescheduledBy = await tx.instalmentPlan.findFirst({
      where: { invoiceId: invoice.id },
      select: { id: true, number: true },
    });
    const dispute = await tx.invoiceDispute.findFirst({
      where: { invoiceId: invoice.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, openedById: true },
    });
    const allocations = await tx.financeAllocation.findMany({
      where: { invoiceId: invoice.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        payment: {
          select: { receiptNumber: true, reversedBy: { select: { id: true } } },
        },
        releases: { select: { amount: true } },
      },
    });
    // A plan the resident may ask for (ADR 0069), read as the request is.
    const terms = await tx.financeSettings.findUniqueOrThrow({
      where: { tenantId: invoice.tenantId },
      select: { planMaxMonths: true, planOfferMinAmount: true },
    });
    const waiting = await tx.instalmentPlanRequest.findFirst({
      where: { invoiceId: invoice.id, status: 'pending' },
      select: { id: true },
    });
    const outstanding = money(view.outstanding);
    const splittable =
      !instalmentOf &&
      !rescheduledBy &&
      dispute?.status !== 'open' &&
      outstanding.gt(ZERO);
    return {
      ...view,
      batchId: invoice.batchId,
      plan:
        invoice.planId && invoice.periodStartsOn && invoice.periodEndsOn
          ? {
              id: invoice.planId,
              periodStartsOn: fromDate(invoice.periodStartsOn),
              periodEndsOn: fromDate(invoice.periodEndsOn),
            }
          : null,
      instalmentPlan: instalmentOf
        ? {
            id: instalmentOf.id,
            number: formatNumber('instalment_plan', instalmentOf.number),
            position: invoice.instalmentPosition!,
            count: instalmentOf.instalmentCount,
          }
        : null,
      rescheduledBy: rescheduledBy
        ? {
            id: rescheduledBy.id,
            number: formatNumber('instalment_plan', rescheduledBy.number),
          }
        : null,
      dispute: dispute
        ? {
            id: dispute.id,
            status: dispute.status,
            mine: dispute.openedById === this.ctx.accountId,
          }
        : null,
      lines: lines.map((l) => ({
        position: l.position,
        descriptionEn: l.descriptionEn,
        descriptionAr: l.descriptionAr,
        amount: show(l.amount),
      })),
      creditNotes: await creditNoteViews(tx, notes),
      allocations: allocations.map((a) => ({
        paymentId: a.paymentId,
        receiptNumber: formatNumber('receipt', a.payment.receiptNumber!),
        amount: show(a.amount),
        released: show(a.releases.reduce((sum, r) => sum.add(r.amount), ZERO)),
        reversed: a.payment.reversedBy !== null,
        createdAt: a.createdAt,
      })),
      planOffer: {
        mayRequest: splittable && !waiting,
        offered:
          splittable &&
          terms.planOfferMinAmount !== null &&
          !terms.planOfferMinAmount.gt(outstanding),
        maxMonths: terms.planMaxMonths,
        pendingRequestId: splittable ? (waiting?.id ?? null) : null,
      },
    };
  }
}

/** The target an issue names, its fields checked against each other. */
function issueTarget(
  dto: IssueInvoicesDto,
): { unitId: string } | { building: string } | 'all' {
  const fields: FieldError[] = [];
  const want = (field: 'unitId' | 'building', needed: boolean) => {
    if (needed && dto[field] === undefined)
      fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
    if (!needed && dto[field] !== undefined)
      fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
  };
  want('unitId', dto.target === 'unit');
  want('building', dto.target === 'building');
  if (fields.length) throw invalid(fields);
  if (dto.target === 'unit') return { unitId: dto.unitId! };
  if (dto.target === 'building') return { building: dto.building! };
  return 'all';
}

export function invoiceView(
  i: Invoice,
  unitCode: string,
  b: Balance,
  today: LocalDate,
): InvoiceView {
  const dueOn = fromDate(i.dueOn);
  return {
    id: i.id,
    number: formatNumber('invoice', i.number),
    unitId: i.unitId,
    unitCode,
    kind: i.kind,
    total: show(i.total),
    currency: i.currency,
    credited: show(b.credited),
    paid: show(b.paid),
    outstanding: show(b.outstanding),
    status: statusOf(b, dueOn, today),
    issuedOn: fromDate(i.issuedOn),
    dueOn,
    createdAt: i.createdAt,
  };
}

export function creditNoteView(n: {
  id: string;
  number: number;
  invoiceId: string;
  amount: Prisma.Decimal;
  reasonCode: string;
  compensationReason: string | null;
  createdAt: Date;
  released: Prisma.Decimal;
}): CreditNoteView {
  return {
    id: n.id,
    number: formatNumber('credit_note', n.number),
    invoiceId: n.invoiceId,
    amount: show(n.amount),
    released: show(n.released),
    reasonCode: n.reasonCode,
    compensationReason: n.compensationReason,
    createdAt: n.createdAt,
  };
}

/** Credit notes with what each gave back to the unit's credit. */
export async function creditNoteViews(
  tx: TenantTxClient,
  notes: readonly {
    id: string;
    number: number;
    invoiceId: string;
    amount: Prisma.Decimal;
    reasonCode: string;
    compensationReason: string | null;
    createdAt: Date;
  }[],
): Promise<CreditNoteView[]> {
  if (!notes.length) return [];
  const released = await tx.financeAllocationRelease.groupBy({
    by: ['creditNoteId'],
    where: { creditNoteId: { in: notes.map((n) => n.id) } },
    _sum: { amount: true },
  });
  return notes.map((n) =>
    creditNoteView({
      ...n,
      released: money(
        released.find((r) => r.creditNoteId === n.id)?._sum.amount ?? 0,
      ),
    }),
  );
}

/**
 * Writes a credit note of `amount` off an invoice, under the unit's finance
 * lock the caller holds (ADR 0046, 0048). It may take at most what credit
 * notes have not yet taken (the total less them): what it owes, and what
 * was paid on it. Beyond what it owes, the invoice's newest live payments
 * are released to the unit's credit. The caller supersedes checkouts and
 * re-allocates.
 */
export async function creditInvoice(
  tx: TenantTxClient,
  input: {
    id: string;
    tenantId: string;
    invoiceId: string;
    amount: Prisma.Decimal;
    reasonCode: string;
    compensationReason?: string | null;
    createdById: string;
    instalmentPlanId?: string;
    disputeId?: string;
  },
) {
  const balance = (await balancesOf(tx, [input.invoiceId])).get(
    input.invoiceId,
  )!;
  const creditable = balance.total.sub(balance.credited);
  if (input.amount.gt(creditable))
    throw appError.conflict(
      ErrorCode.CREDIT_EXCEEDS_CREDITABLE,
      'More than credit notes may still take off the invoice',
      {
        params: {
          creditable: show(creditable),
          outstanding: show(balance.outstanding),
        },
      },
    );
  const number = await takeNumbers(tx, input.tenantId, 'credit_note');
  const note = await tx.creditNote.create({
    data: {
      id: input.id,
      tenantId: input.tenantId,
      number,
      invoiceId: input.invoiceId,
      amount: input.amount,
      reasonCode: input.reasonCode,
      createdById: input.createdById,
      instalmentPlanId: input.instalmentPlanId ?? null,
      disputeId: input.disputeId ?? null,
      compensationReason: input.compensationReason ?? null,
    },
  });
  const excess = input.amount.sub(balance.outstanding);
  const released = excess.gt(ZERO) ? excess : ZERO;
  if (released.gt(ZERO))
    await releaseNewest(tx, input.tenantId, input.invoiceId, note.id, released);
  return { note, released };
}

function batchView(
  b: {
    id: string;
    target: string;
    unitId: string | null;
    building: string | null;
    kind: Invoice['kind'];
    unitCount: number;
    issuedOn: Date;
    dueOn: Date;
    createdAt: Date;
  },
  total: Prisma.Decimal.Value,
  first: number,
  last: number,
): InvoiceBatchView {
  return {
    id: b.id,
    target: b.target,
    unitId: b.unitId,
    building: b.building,
    kind: b.kind,
    unitCount: b.unitCount,
    total: show(total),
    firstNumber: formatNumber('invoice', first),
    lastNumber: formatNumber('invoice', last),
    issuedOn: fromDate(b.issuedOn),
    dueOn: fromDate(b.dueOn),
    createdAt: b.createdAt,
  };
}

/** `creditNoteCompensation`: required on a compensation (ADR 0058). */
function requireCompensationReason(code: string | undefined): string {
  if (!code)
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A compensation says why',
      {
        fields: [
          {
            field: 'compensationReasonCode',
            code: FieldErrorCode.FIELD_REQUIRED,
          },
        ],
      },
    );
  if (
    !(REASON_CODES.creditNoteCompensation as readonly string[]).includes(code)
  )
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Unknown reason code',
      {
        fields: [
          {
            field: 'compensationReasonCode',
            code: FieldErrorCode.INVALID_REASON_CODE,
            params: { allowed: [...REASON_CODES.creditNoteCompensation] },
          },
        ],
      },
    );
  return code;
}
