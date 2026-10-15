import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type FinanceRefund } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { StepUpService } from '../../core/auth/step-up.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, fromDate } from '../db-clock';
import { InvoicesService } from '../invoices/invoices.service';
import { CURRENCY, money, show, ZERO } from '../money';
import { allocateUnit, freeMoney } from '../payments/allocation';
import type { RecordRefundDto, ReverseRefundDto } from './dto/refunds.dto';
import type { RefundView } from './views/refund.views';

export const REFUND_RESOURCE = 'refund';
export const REFUND_REVERSAL_RESOURCE = 'refund_reversal';
/** How far back a refund may be dated (ADR 0048). */
export const REFUNDED_ON_DAYS = 31;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const refundNotFound = () =>
  appError.notFound(ErrorCode.REFUND_NOT_FOUND, 'Refund not found');

export interface RefundFilter {
  unitId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

const cursor = keysetCursor('createdAt');

/**
 * Refunds of a unit's credit (ADR 0048): money live payments gave to no
 * invoice, paid back by hand (cash, a transfer, or in the gateway's own
 * dashboard; no gateway call). Manager only, after a step-up. The refund
 * takes its amount from those payments' free money, newest first, as
 * append-only sources, so the allocator never pours what was paid back. A
 * reversal returns the money to credit, which then pays what is owed.
 */
@Injectable()
export class RefundsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly stepUp: StepUpService,
    private readonly community: CommunityFinancePort,
    private readonly access: FinanceAccess,
    private readonly invoices: InvoicesService,
  ) {}

  onModuleInit(): void {
    const render = (id: string) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.viewOf(
          tx,
          await tx.financeRefund.findUniqueOrThrow({ where: { id } }),
        ),
      );
    this.idempotency.renderer(REFUND_RESOURCE, render);
    this.idempotency.renderer(REFUND_REVERSAL_RESOURCE, render);
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /**
   * Pays back part or all of the unit's credit. Locks in order: the
   * caller's account, then its session's step-up (deactivation and freeze
   * lock the account before the sessions), then the unit. A replay never
   * reaches the step-up; a refused refund rolls it back, still usable. An
   * unknown unit or a bad day is answered before the step-up is asked.
   */
  record(unitId: string, dto: RecordRefundDto): Promise<RefundView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: REFUND_RESOURCE, id });
      await this.access.lockSelf(tx);
      if (!(await this.community.units(tx, [unitId])).has(unitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const today = await this.invoices.today(tx);
      const earliest = addDays(today, -REFUNDED_ON_DAYS);
      if (dto.refundedOn > today || dto.refundedOn < earliest)
        throw invalid([
          {
            field: 'refundedOn',
            code: FieldErrorCode.REFUNDED_ON_OUT_OF_RANGE,
            params: { min: earliest, max: today },
          },
        ]);
      await this.stepUp.consume(tx);
      await this.access.lockUnits(tx, [unitId]);
      // Newest money first: credit is most often a recent overpayment.
      const free = await freeMoney(tx, unitId, undefined, 'newest');
      const credit = free.reduce((sum, p) => sum.add(p.free), ZERO);
      const amount = money(dto.amount);
      if (amount.gt(credit))
        throw appError.conflict(
          ErrorCode.REFUND_EXCEEDS_CREDIT,
          'More than the unit’s credit',
          { params: { credit: show(credit) } },
        );
      const tenantId = this.ctx.txTenantId;
      const number = await takeNumbers(tx, tenantId, 'refund');
      await tx.financeRefund.create({
        data: {
          id,
          tenantId,
          kind: 'refund',
          unitId,
          number,
          amount,
          currency: CURRENCY,
          channel: dto.channel,
          reference: dto.reference ?? null,
          refundedOn: asDate(dto.refundedOn),
          recordedById: this.ctx.accountId,
        },
      });
      const sources: Prisma.FinanceRefundSourceCreateManyInput[] = [];
      let left = amount;
      for (const p of free) {
        if (left.lte(ZERO)) break;
        const take = Prisma.Decimal.min(p.free, left);
        sources.push({
          id: newId(),
          tenantId,
          refundId: id,
          paymentId: p.id,
          amount: take,
        });
        left = left.sub(take);
      }
      await tx.financeRefundSource.createMany({ data: sources });
      await this.audit.record(tx, {
        action: 'refund.recorded',
        targetId: id,
        metadata: {
          unitId,
          number: formatNumber('refund', number),
          amount: show(amount),
          channel: dto.channel,
          refundedOn: dto.refundedOn,
          sourceCount: sources.length,
        },
      });
      return this.detailIn(tx, id);
    });
  }

  /** Undoes a refund: the money is the unit's credit again, at once applied. */
  reverse(refundId: string, dto: ReverseRefundDto): Promise<RefundView> {
    const reasonCode = requireReasonCodeOnly(
      dto.reasonCode,
      REASON_CODES.refundReverse,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.idempotency.claim(tx, {
        type: REFUND_REVERSAL_RESOURCE,
        id: refundId,
      });
      await this.access.lockSelf(tx);
      const refund = await tx.financeRefund.findUnique({
        where: { id: refundId },
      });
      if (refund?.kind !== 'refund') throw refundNotFound();
      await this.access.lockUnits(tx, [refund.unitId]);
      const already = await tx.financeRefund.findFirst({
        where: { reversesId: refundId },
        select: { id: true },
      });
      if (already)
        throw appError.conflict(
          ErrorCode.REFUND_ALREADY_REVERSED,
          'Reversed already',
        );
      await tx.financeRefund.create({
        data: {
          id: newId(),
          tenantId: refund.tenantId,
          kind: 'reversal',
          unitId: refund.unitId,
          reversesId: refundId,
          reasonCode,
          recordedById: this.ctx.accountId,
        },
      });
      // The money is credit again: it pays what the unit owes.
      await allocateUnit(tx, refund.tenantId, refund.unitId);
      await this.audit.record(tx, {
        action: 'refund.reversed',
        targetId: refundId,
        metadata: {
          refundId,
          unitId: refund.unitId,
          amount: show(refund.amount!),
          reasonCode,
        },
      });
      return this.detailIn(tx, refundId);
    });
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** The staff's list, newest first. */
  list(filter: RefundFilter): Promise<Page<RefundView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeRefund.findMany({
        where: {
          kind: 'refund',
          ...(filter.unitId ? { unitId: filter.unitId } : {}),
          ...(filter.from || filter.to
            ? {
                refundedOn: {
                  ...(filter.from ? { gte: asDate(filter.from) } : {}),
                  ...(filter.to ? { lte: asDate(filter.to) } : {}),
                },
              }
            : {}),
          AND: cursor.after(filter.cursor),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filter.limit + 1,
      });
      const page = cursor.toPage(rows, filter.limit);
      return {
        items: await this.views(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  detail(id: string): Promise<RefundView> {
    return this.tenantTx.withTenantTx((tx) => this.detailIn(tx, id));
  }

  private async detailIn(tx: TenantTxClient, id: string): Promise<RefundView> {
    const refund = await tx.financeRefund.findUnique({ where: { id } });
    if (refund?.kind !== 'refund') throw refundNotFound();
    return this.viewOf(tx, refund);
  }

  private async viewOf(
    tx: TenantTxClient,
    refund: FinanceRefund,
  ): Promise<RefundView> {
    const [view] = await this.views(tx, [refund]);
    return view;
  }

  private async views(
    tx: TenantTxClient,
    refunds: readonly FinanceRefund[],
  ): Promise<RefundView[]> {
    if (!refunds.length) return [];
    const ids = refunds.map((r) => r.id);
    const reversals = await tx.financeRefund.findMany({
      where: { reversesId: { in: ids } },
    });
    const sources = await tx.financeRefundSource.findMany({
      where: { refundId: { in: ids } },
      include: { payment: { select: { receiptNumber: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const units = await this.community.units(
      tx,
      refunds.map((r) => r.unitId),
    );
    const names = await this.community.staffNames(tx, [
      ...refunds.map((r) => r.recordedById),
      ...reversals.map((r) => r.recordedById),
    ]);
    const ref = (id: string) => ({ id, fullName: names.get(id) ?? null });
    return refunds.map((r) => {
      const reversal = reversals.find((x) => x.reversesId === r.id) ?? null;
      return {
        id: r.id,
        number: formatNumber('refund', r.number!),
        unitId: r.unitId,
        unitCode: units.get(r.unitId)?.code ?? '',
        amount: show(r.amount!),
        currency: r.currency!,
        channel: r.channel!,
        reference: r.reference,
        refundedOn: fromDate(r.refundedOn!),
        recordedBy: ref(r.recordedById),
        sources: sources
          .filter((s) => s.refundId === r.id)
          .map((s) => ({
            paymentId: s.paymentId,
            receiptNumber: formatNumber('receipt', s.payment.receiptNumber!),
            amount: show(s.amount),
          })),
        reversal: reversal
          ? {
              id: reversal.id,
              reasonCode: reversal.reasonCode!,
              recordedBy: ref(reversal.recordedById),
              createdAt: reversal.createdAt,
            }
          : null,
        createdAt: r.createdAt,
      };
    });
  }
}
