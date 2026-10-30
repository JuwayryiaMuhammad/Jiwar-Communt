import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type FinancePayment } from '@prisma/client';
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
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, fromDate } from '../db-clock';
import { GatewayService } from '../gateway/gateway.service';
import {
  balancesOf,
  CREDITED_SQL,
  DISPUTED_SQL,
  disputedAmong,
  PAID_SQL,
} from '../invoices/balances';
import { invoiceView, InvoicesService } from '../invoices/invoices.service';
import { CURRENCY, money, show, ZERO } from '../money';
import { FinanceNotices } from '../notices/finance-notices';
import { supersedeLive } from '../online/supersede';
import { allocateUnit, applyPayment, unitCredit } from './allocation';
import { newReceiptCode, receiptCodeHash, receiptUrl } from './receipts';
import type {
  RecordOfficePaymentDto,
  ReversePaymentDto,
} from './dto/payments.dto';
import type {
  PaymentDetailView,
  PaymentView,
  StatementEntryView,
  StatementView,
} from './views/payment.views';

export const PAYMENT_RESOURCE = 'payment';
/** How far back an office payment's day may be. */
export const PAID_ON_DAYS = 31;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const paymentNotFound = () =>
  appError.notFound(ErrorCode.PAYMENT_NOT_FOUND, 'Payment not found');

const unitNotFound = () =>
  appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');

export interface PaymentListFilter {
  channel?: FinancePayment['channel'];
  method?: FinancePayment['method'];
  unitId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

/** What a new payment is, whoever records it. */
export interface NewPayment {
  unitId: string;
  channel: 'office' | 'online';
  method: NonNullable<FinancePayment['method']>;
  amount: Prisma.Decimal;
  paidOn: LocalDate;
  reference: string | null;
  recordedById: string | null;
  /** Invoices it pays first. */
  named: readonly string[];
  /** Online only: the checkout, Paymob's transaction and who paid. */
  online?: { sessionId: string; transactionId: string; payerId: string };
}

const cursor = keysetCursor('createdAt');

/**
 * A unit's payments and receipts (ADR 0046): at the office (recorded by
 * finance.payments, reversed by a new row) and online (the webhook, through
 * `create`). Every payment is allocated oldest due first under the unit's
 * finance lock; what nothing owed absorbs stays the unit's credit.
 */
@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly publicAppUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly globalDb: GlobalDbService,
    private readonly community: CommunityFinancePort,
    private readonly access: FinanceAccess,
    private readonly notices: FinanceNotices,
    private readonly invoices: InvoicesService,
    private readonly gateway: GatewayService,
  ) {
    this.publicAppUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  onModuleInit(): void {
    this.idempotency.renderer(PAYMENT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const row = await tx.financePayment.findUniqueOrThrow({
          where: { id },
        });
        // A reversal's key replays the payment it reversed.
        return this.detailIn(tx, row.reversesId ?? row.id, true);
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /**
   * A payment made at the office: at most what the invoices named (or all
   * the unit's) still ask for — the office never takes credit.
   */
  recordOffice(
    unitId: string,
    dto: RecordOfficePaymentDto,
  ): Promise<PaymentDetailView> {
    const needsReference = dto.method !== 'cash';
    if (needsReference !== (dto.reference !== undefined))
      throw invalid([
        {
          field: 'reference',
          code: needsReference
            ? FieldErrorCode.FIELD_REQUIRED
            : FieldErrorCode.FIELD_NOT_ALLOWED,
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: PAYMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      if (!(await this.community.units(tx, [unitId])).has(unitId))
        throw unitNotFound();
      const today = await this.invoices.today(tx);
      const earliest = addDays(today, -PAID_ON_DAYS);
      if (dto.paidOn > today || dto.paidOn < earliest)
        throw invalid([
          {
            field: 'paidOn',
            code: FieldErrorCode.PAID_ON_OUT_OF_RANGE,
            params: { min: earliest, max: today },
          },
        ]);
      await this.access.lockUnits(tx, [unitId]);
      const named = dto.invoiceIds ?? [];
      const outstanding = await this.owed(tx, unitId, named);
      const amount = money(dto.amount);
      if (amount.gt(outstanding))
        throw appError.conflict(
          ErrorCode.PAYMENT_EXCEEDS_OUTSTANDING,
          'More than is owed',
          { params: { outstanding: show(outstanding) } },
        );
      await supersedeLive(tx, [unitId]);
      await this.create(tx, id, {
        unitId,
        channel: 'office',
        method: dto.method,
        amount,
        paidOn: dto.paidOn,
        reference: dto.reference ?? null,
        recordedById: this.ctx.accountId,
        named,
      });
      return this.detailIn(tx, id, true);
    });
  }

  /**
   * Writes a payment, its receipt and its allocations, audits it and tells
   * the unit. Under the unit's finance lock, which the caller holds. Shared
   * with the webhook.
   */
  async create(
    tx: TenantTxClient,
    id: string,
    p: NewPayment,
  ): Promise<FinancePayment> {
    const tenantId = this.ctx.txTenantId;
    const receipt = await takeNumbers(tx, tenantId, 'receipt');
    const code = newReceiptCode();
    const payment = await tx.financePayment.create({
      data: {
        id,
        tenantId,
        kind: 'payment',
        unitId: p.unitId,
        channel: p.channel,
        method: p.method,
        amount: p.amount,
        currency: CURRENCY,
        paidOn: asDate(p.paidOn),
        receiptNumber: receipt,
        receiptCode: code,
        reference: p.reference,
        recordedById: p.recordedById,
        sessionId: p.online?.sessionId ?? null,
        gatewayTransactionId: p.online?.transactionId ?? null,
        payerId: p.online?.payerId ?? null,
      },
    });
    await this.globalDb.in(tx).receiptLink.create({
      data: { codeHash: receiptCodeHash(code), tenantId, paymentId: id },
    });
    await applyPayment(tx, tenantId, p.unitId, id, p.named);
    await this.audit.record(tx, {
      action: 'payment.recorded',
      targetId: id,
      metadata: {
        unitId: p.unitId,
        channel: p.channel,
        method: p.method,
        amount: show(p.amount),
        paidOn: p.paidOn,
        receiptNumber: formatNumber('receipt', receipt),
        ...(p.named.length ? { invoiceIds: [...p.named] } : {}),
        ...(p.online
          ? {
              sessionId: p.online.sessionId,
              gatewayTransactionId: p.online.transactionId,
            }
          : {}),
      },
    });
    await this.notices.toUnit(tx, p.unitId, 'payment.received', id);
    return payment;
  }

  /** Reverses an office payment, once; the unit's other credit then pays what it freed. */
  reverse(
    paymentId: string,
    dto: ReversePaymentDto,
  ): Promise<PaymentDetailView> {
    const reasonCode = requireReasonCodeOnly(
      dto.reasonCode,
      REASON_CODES.paymentReverse,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: PAYMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const payment = await tx.financePayment.findUnique({
        where: { id: paymentId },
      });
      if (payment?.kind !== 'payment') throw paymentNotFound();
      if (payment.channel !== 'office')
        throw appError.conflict(
          ErrorCode.PAYMENT_NOT_REVERSIBLE,
          'An online payment cannot be reversed',
        );
      await this.access.lockUnits(tx, [payment.unitId]);
      const already = await tx.financePayment.findFirst({
        where: { reversesId: paymentId },
        select: { id: true },
      });
      if (already)
        throw appError.conflict(
          ErrorCode.PAYMENT_ALREADY_REVERSED,
          'Reversed already',
        );
      // Its money left the compound as a refund already (ADR 0048).
      const refunded = await tx.financeRefundSource.findFirst({
        where: { paymentId, refund: { reversedBy: null } },
        select: { id: true },
      });
      if (refunded)
        throw appError.conflict(
          ErrorCode.PAYMENT_REFUNDED,
          'Money of this payment was refunded',
        );
      await tx.financePayment.create({
        data: {
          id,
          tenantId: payment.tenantId,
          kind: 'reversal',
          unitId: payment.unitId,
          reversesId: paymentId,
          reasonCode,
          recordedById: this.ctx.accountId,
        },
      });
      await allocateUnit(tx, payment.tenantId, payment.unitId);
      await this.audit.record(tx, {
        action: 'payment.reversed',
        targetId: id,
        metadata: {
          paymentId,
          unitId: payment.unitId,
          amount: show(payment.amount!),
          reasonCode,
        },
      });
      return this.detailIn(tx, paymentId, true);
    });
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  list(filter: PaymentListFilter): Promise<Page<PaymentView>> {
    return this.tenantTx.withTenantTx((tx) => this.listIn(tx, filter, true));
  }

  forUnit(
    unitId: string,
    filter: Pick<PaymentListFilter, 'cursor' | 'limit'>,
  ): Promise<Page<PaymentView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.invoices.assertSees(tx, unitId);
      return this.listIn(tx, { ...filter, unitId }, false);
    });
  }

  detail(id: string): Promise<PaymentDetailView> {
    return this.tenantTx.withTenantTx((tx) => this.detailIn(tx, id, true));
  }

  /**
   * A payment in the caller's transaction (ADR 0069, a receipt's PDF): the
   * staff's, or one of the caller's units' (financeView); else not found.
   */
  async readable(
    tx: TenantTxClient,
    id: string,
    staff: boolean,
  ): Promise<PaymentDetailView> {
    if (!staff) {
      const p = await tx.financePayment.findUnique({ where: { id } });
      if (p?.kind !== 'payment') throw paymentNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        p.unitId,
      );
      if (!caps?.financeView) throw paymentNotFound();
    }
    return this.detailIn(tx, id, staff);
  }

  /** One of the caller's units' payments; else not found. */
  mine(id: string): Promise<PaymentDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await tx.financePayment.findUnique({ where: { id } });
      if (p?.kind !== 'payment') throw paymentNotFound();
      const caps = await this.community.placeIn(
        tx,
        this.ctx.accountId,
        p.unitId,
      );
      if (!caps?.financeView) throw paymentNotFound();
      return this.detailIn(tx, id, false);
    });
  }

  /** Where a unit stands; `staff` or someone who sees its money. */
  statement(unitId: string, staff: boolean): Promise<StatementView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (staff) {
        if (!(await this.community.units(tx, [unitId])).has(unitId))
          throw unitNotFound();
      } else {
        await this.invoices.assertSees(tx, unitId);
      }
      const unit = (await this.community.units(tx, [unitId])).get(unitId)!;
      const today = await this.invoices.today(tx);
      const open = await tx.$queryRaw<{ id: string }[]>`
        SELECT i.id FROM invoices i
         WHERE i.unit_id = ${unitId}::uuid
           AND i.total - ${CREDITED_SQL} - ${PAID_SQL} > 0
         ORDER BY i.due_on, i.number`;
      const invoices = await tx.invoice.findMany({
        where: { id: { in: open.map((o) => o.id) } },
        orderBy: [{ dueOn: 'asc' }, { number: 'asc' }],
      });
      const balances = await balancesOf(
        tx,
        invoices.map((i) => i.id),
      );
      const outstanding = invoices.reduce(
        (sum, i) => sum.add(balances.get(i.id)!.outstanding),
        ZERO,
      );
      return {
        unitId,
        unitCode: unit.code,
        outstanding: show(outstanding),
        credit: show(await unitCredit(tx, unitId)),
        openInvoices: invoices.map((i) =>
          invoiceView(i, unit.code, balances.get(i.id)!, today),
        ),
        entries: await this.entries(tx, unitId),
        onlinePayment: (await this.gateway.view(tx, this.ctx.txTenantId))
          .available,
      };
    });
  }

  // --------------------------------------------------------------------------

  /**
   * What the invoices named (or all the unit's) still ask for. An invoice
   * under an open dispute is frozen (ADR 0048): naming it is refused, and
   * it is not part of "all".
   */
  private async owed(
    tx: TenantTxClient,
    unitId: string,
    named: readonly string[],
  ): Promise<Prisma.Decimal> {
    if (named.length) {
      const rows = await tx.invoice.findMany({
        where: { id: { in: [...named] }, unitId },
        select: { id: true },
      });
      const balances = await balancesOf(
        tx,
        rows.map((r) => r.id),
      );
      const bad = named.filter((id) => !balances.get(id)?.outstanding.gt(ZERO));
      if (bad.length)
        throw appError.conflict(
          ErrorCode.INVOICE_NOT_PAYABLE,
          'Not the unit’s, or nothing owed',
          { params: { invoiceIds: bad } },
        );
      const disputed = await disputedAmong(tx, named);
      if (disputed.length)
        throw appError.conflict(
          ErrorCode.INVOICE_DISPUTED,
          'Under an open dispute',
          { params: { invoiceIds: disputed } },
        );
      return [...balances.values()].reduce(
        (sum, b) => sum.add(b.outstanding),
        ZERO,
      );
    }
    const [{ owed }] = await tx.$queryRaw<{ owed: Prisma.Decimal | null }[]>`
      SELECT SUM(GREATEST(i.total - ${CREDITED_SQL} - ${PAID_SQL}, 0)) AS owed
        FROM invoices i
       WHERE i.unit_id = ${unitId}::uuid AND NOT ${DISPUTED_SQL}`;
    return money(owed ?? 0);
  }

  private async listIn(
    tx: TenantTxClient,
    filter: PaymentListFilter,
    staff: boolean,
  ): Promise<Page<PaymentView>> {
    const rows = await tx.financePayment.findMany({
      where: {
        AND: [
          { kind: 'payment' },
          filter.channel ? { channel: filter.channel } : {},
          filter.method ? { method: filter.method } : {},
          filter.unitId ? { unitId: filter.unitId } : {},
          filter.from ? { paidOn: { gte: asDate(filter.from) } } : {},
          filter.to ? { paidOn: { lte: asDate(filter.to) } } : {},
          ...cursor.after(filter.cursor),
        ],
      },
      orderBy: cursor.orderBy,
      take: filter.limit + 1,
    });
    const page = cursor.toPage(rows, filter.limit);
    return {
      items: await this.views(tx, page.items, staff),
      nextCursor: page.nextCursor,
    };
  }

  private async views(
    tx: TenantTxClient,
    payments: readonly FinancePayment[],
    staff: boolean,
  ): Promise<PaymentView[]> {
    if (!payments.length) return [];
    const ids = payments.map((p) => p.id);
    const reversals = await tx.financePayment.findMany({
      where: { reversesId: { in: ids } },
    });
    const allocated = await tx.financeAllocation.groupBy({
      by: ['paymentId'],
      where: { paymentId: { in: ids } },
      _sum: { amount: true },
    });
    // What credit notes gave back of each payment's allocations (ADR 0048).
    const releasedRows = await tx.$queryRaw<
      { payment_id: string; released: Prisma.Decimal }[]
    >`
      SELECT a.payment_id, SUM(x.amount) AS released
        FROM finance_allocation_releases x
        JOIN finance_allocations a ON a.tenant_id = x.tenant_id AND a.id = x.allocation_id
       WHERE a.payment_id = ANY(${ids}::uuid[])
       GROUP BY a.payment_id`;
    // What live refunds took from each payment (ADR 0048).
    const refunded = await tx.financeRefundSource.groupBy({
      by: ['paymentId'],
      where: { paymentId: { in: ids }, refund: { reversedBy: null } },
      _sum: { amount: true },
    });
    const units = await this.community.units(
      tx,
      payments.map((p) => p.unitId),
    );
    const names = staff
      ? await this.community.staffNames(
          tx,
          payments.flatMap((p) => (p.recordedById ? [p.recordedById] : [])),
        )
      : new Map<string, string | null>();
    return payments.map((p) => {
      const reversal = reversals.find((r) => r.reversesId === p.id) ?? null;
      const given = reversal
        ? ZERO
        : money(
            allocated.find((a) => a.paymentId === p.id)?._sum.amount ?? 0,
          ).sub(
            money(
              releasedRows.find((r) => r.payment_id === p.id)?.released ?? 0,
            ),
          );
      const paidBack = reversal
        ? ZERO
        : money(refunded.find((r) => r.paymentId === p.id)?._sum.amount ?? 0);
      return {
        id: p.id,
        unitId: p.unitId,
        unitCode: units.get(p.unitId)?.code ?? '',
        channel: p.channel!,
        method: p.method!,
        amount: show(p.amount!),
        currency: p.currency!,
        paidOn: fromDate(p.paidOn!),
        receiptNumber: formatNumber('receipt', p.receiptNumber!),
        receiptCode: p.receiptCode!,
        receiptUrl: receiptUrl(this.publicAppUrl, p.receiptCode!),
        reference: p.reference,
        allocated: show(given),
        refunded: show(paidBack),
        unallocated: show(reversal ? ZERO : p.amount!.sub(given).sub(paidBack)),
        reversal: reversal
          ? {
              id: reversal.id,
              reasonCode: reversal.reasonCode!,
              createdAt: reversal.createdAt,
            }
          : null,
        recordedBy:
          staff && p.recordedById
            ? {
                id: p.recordedById,
                fullName: names.get(p.recordedById) ?? null,
              }
            : null,
        createdAt: p.createdAt,
      };
    });
  }

  private async detailIn(
    tx: TenantTxClient,
    id: string,
    staff: boolean,
  ): Promise<PaymentDetailView> {
    const p = await tx.financePayment.findUnique({ where: { id } });
    if (p?.kind !== 'payment') throw paymentNotFound();
    const [view] = await this.views(tx, [p], staff);
    const allocations = await tx.financeAllocation.findMany({
      where: { paymentId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { invoice: { select: { number: true } } },
    });
    return {
      ...view,
      allocations: allocations.map((a) => ({
        invoiceId: a.invoiceId,
        invoiceNumber: formatNumber('invoice', a.invoice.number),
        amount: show(a.amount),
      })),
    };
  }

  /** The unit's latest 100 entries, newest first. */
  private async entries(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<StatementEntryView[]> {
    const rows = await tx.$queryRaw<
      {
        kind: StatementEntryView['kind'];
        id: string;
        number: number;
        prefix: string;
        amount: Prisma.Decimal;
        released: Prisma.Decimal | null;
        at: Date;
      }[]
    >`
      SELECT * FROM (
        SELECT 'invoice' AS kind, i.id, i.number, 'invoice' AS prefix, i.total AS amount,
               NULL::numeric AS released, i.created_at AS at
          FROM invoices i WHERE i.unit_id = ${unitId}::uuid
        UNION ALL
        SELECT 'credit_note', c.id, c.number, 'credit_note', c.amount,
               COALESCE((SELECT SUM(x.amount) FROM finance_allocation_releases x
                          WHERE x.tenant_id = c.tenant_id AND x.credit_note_id = c.id), 0),
               c.created_at
          FROM credit_notes c JOIN invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
         WHERE i.unit_id = ${unitId}::uuid
        UNION ALL
        SELECT 'payment', p.id, p.receipt_number, 'receipt', p.amount, NULL, p.created_at
          FROM finance_payments p WHERE p.unit_id = ${unitId}::uuid AND p.kind = 'payment'
        UNION ALL
        SELECT 'reversal', r.id, p.receipt_number, 'receipt', p.amount, NULL, r.created_at
          FROM finance_payments r JOIN finance_payments p ON p.tenant_id = r.tenant_id AND p.id = r.reverses_id
         WHERE r.unit_id = ${unitId}::uuid AND r.kind = 'reversal'
        UNION ALL
        SELECT 'refund', f.id, f.number, 'refund', f.amount, NULL, f.created_at
          FROM finance_refunds f WHERE f.unit_id = ${unitId}::uuid AND f.kind = 'refund'
        UNION ALL
        SELECT 'refund_reversal', r.id, f.number, 'refund', f.amount, NULL, r.created_at
          FROM finance_refunds r JOIN finance_refunds f ON f.tenant_id = r.tenant_id AND f.id = r.reverses_id
         WHERE r.unit_id = ${unitId}::uuid AND r.kind = 'reversal'
      ) e ORDER BY e.at DESC, e.id DESC LIMIT 100`;
    return rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      number: formatNumber(
        r.prefix as 'invoice' | 'credit_note' | 'receipt' | 'refund',
        r.number,
      ),
      amount: show(r.amount),
      released: r.released === null ? null : show(r.released),
      at: r.at,
    }));
  }
}
