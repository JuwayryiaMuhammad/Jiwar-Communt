import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type WorkerEngagement,
  type WorkerWagePayment,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { COMMUNITY_NOTICES } from '../notices/community-notices';
import { CommunityNotifier } from '../notices/community-notifier';
import { lockUnits } from '../units/unit-lock';
import { WorkersAuthority } from './workers-authority';
import { WorkersService } from './workers.service';

/** Per month, in the compound's currency (ADR 0037). */
export const MAX_WAGE = new Prisma.Decimal('1000000');

/** Statuses a wage may still be set on: the engagement is open. */
const OPEN = new Set(['pending_review', 'active', 'suspended']);
/** Someone who could have worked: active, suspended, or ended after it. */
const PAYABLE = new Set(['active', 'suspended', 'ended']);

const PAYMENT_PAGE = keysetCursor('createdAt');

export interface WagePaymentRead {
  id: string;
  engagementId: string;
  /** `YYYY-MM` */
  period: string;
  /** Two decimals. */
  amount: string;
  paidAt: Date;
  paidBy: { id: string; fullName: string | null; status: string };
}

/**
 * A domestic worker's monthly wage and its payments (ADR 0037). Payments
 * are recorded, never processed (there is no payment gateway): the
 * household says it paid one month, once. The worker gets a notice (the
 * receipt that a future SMS channel delivers) and the payer and the unit's
 * primary an email.
 *
 * Who: whoever may act on the engagement (the requester, the unit's
 * primary, a `workers` delegate: `WorkersAuthority.forEngagement`). Every
 * write locks the unit first (like every engagement change), so two
 * payments for one month are serialized and the second is refused.
 *
 * A payment on an engagement that has ended settles its open
 * `settle_before_close` obligation (ADR 0022): the file may close. The
 * underage `pay_in_full` obligation stays with management.
 */
@Injectable()
export class WorkerWagesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly authority: WorkersAuthority,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
    private readonly notifier: CommunityNotifier,
    private readonly settings: TenantSettingsService,
  ) {}

  /** The agreed monthly wage, or null to clear it; while the engagement is open. */
  async setWage(
    engagementId: string,
    raw: string | number | null | undefined,
  ): Promise<string | null> {
    const wage = raw === null ? null : checkAmount('monthlyWage', raw);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { e, actingFor } = await this.engagement(tx, engagementId);
      if (!OPEN.has(e.status)) throw engagementNotFound();
      const before = e.monthlyWage;
      const after = await tx.workerEngagement.update({
        where: { id: e.id },
        data: { monthlyWage: wage },
      });
      if (!sameAmount(before, wage))
        // The amount stays on the engagement, never in the trail.
        await this.audit.record(tx, {
          action: 'worker.wage_changed',
          targetId: e.id,
          metadata: {
            unitId: e.unitId,
            workerId: e.workerId,
            set: wage !== null,
            ...(actingFor ? { onBehalfOf: actingFor } : {}),
          },
        });
      return after.monthlyWage?.toFixed(2) ?? null;
    });
  }

  /**
   * One month paid: `period` is `YYYY-MM`, not after the compound's
   * current month and not before the engagement's first.
   */
  async pay(
    engagementId: string,
    input: { period: string; amount?: string | number },
  ): Promise<WagePaymentRead> {
    const amount = checkAmount('amount', input.amount);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { e } = await this.engagement(tx, engagementId);
      if (!PAYABLE.has(e.status) || e.codeIssuedAt === null)
        throw appError.conflict(
          ErrorCode.WAGE_NOT_PAYABLE,
          'Nobody worked on this engagement',
        );
      const { timezone } = await this.settings.inTx(tx, e.tenantId);
      const period = checkPeriod(input.period, e.createdAt, timezone);
      const taken = await tx.workerWagePayment.findFirst({
        where: { engagementId: e.id, period },
        select: { id: true },
      });
      if (taken)
        throw appError.conflict(
          ErrorCode.WAGE_PERIOD_ALREADY_PAID,
          'This month is already paid',
          { params: { period: input.period } },
        );
      const payment = await tx.workerWagePayment.create({
        data: {
          id: newId(),
          tenantId: e.tenantId,
          engagementId: e.id,
          workerId: e.workerId,
          unitId: e.unitId,
          period,
          amount,
          paidById: me,
        },
      });
      // The worker's receipt (ADR 0017: a worker notice is never silent).
      await tx.workerNotice.create({
        data: {
          id: newId(),
          tenantId: e.tenantId,
          workerId: e.workerId,
          engagementId: e.id,
          noticeKey: 'wage_paid',
          params: { period: input.period, amount: amount.toFixed(2) },
        },
      });
      if (e.status === 'ended') await this.settle(tx, e, payment.id);
      await this.receipt(tx, e, input.period, amount);
      return read(payment, await this.payer(tx, me));
    });
  }

  /** The engagement's payments, newest first. */
  async payments(
    engagementId: string,
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<WagePaymentRead>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      // A read: no lock, and an expiry is left to the next write.
      const e = await tx.workerEngagement.findUnique({
        where: { id: engagementId },
      });
      if (!e) throw engagementNotFound();
      await this.authority.forEngagement(tx, e);
      const rows = await tx.workerWagePayment.findMany({
        where: {
          AND: [
            { engagementId: e.id },
            ...(PAYMENT_PAGE.after(
              q.cursor,
            ) as Prisma.WorkerWagePaymentWhereInput[]),
          ],
        },
        orderBy: PAYMENT_PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAYMENT_PAGE.toPage(rows, limit);
      const people = await tx.account.findMany({
        where: { id: { in: [...new Set(page.items.map((p) => p.paidById))] } },
        select: { id: true, fullName: true, status: true },
      });
      return {
        items: page.items.map((p) =>
          read(
            p,
            people.find((a) => a.id === p.paidById) ?? {
              id: p.paidById,
              fullName: null,
              status: 'erased',
            },
          ),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * The engagement, its unit locked, the caller's right to act on it
   * checked; a temporary engagement past its end is ended first (and that
   * write commits with the rest).
   */
  private async engagement(
    tx: TenantTxClient,
    engagementId: string,
  ): Promise<{ e: WorkerEngagement; actingFor: string | null }> {
    const found = await tx.workerEngagement.findUnique({
      where: { id: engagementId },
      select: { unitId: true },
    });
    if (!found) throw engagementNotFound();
    await lockUnits(tx, [found.unitId]);
    const e = await tx.workerEngagement.findUniqueOrThrow({
      where: { id: engagementId },
    });
    const by = await this.authority.forEngagement(tx, e);
    if (await this.workers.expireIfDue(tx, e))
      return {
        e: await tx.workerEngagement.findUniqueOrThrow({
          where: { id: engagementId },
        }),
        actingFor: by.onBehalfOf,
      };
    return { e, actingFor: by.onBehalfOf };
  }

  /** The wage is settled: the worker's file may close (ADR 0022). */
  private async settle(
    tx: TenantTxClient,
    e: WorkerEngagement,
    paymentId: string,
  ): Promise<void> {
    const open = await tx.workerWageObligation.findMany({
      where: {
        engagementId: e.id,
        kind: 'settle_before_close',
        settledAt: null,
      },
      select: { id: true, kind: true },
    });
    for (const o of open) {
      await tx.workerWageObligation.update({
        where: { id: o.id },
        data: { settledAt: new Date(), settledById: this.ctx.accountId },
      });
      await this.audit.record(tx, {
        action: 'worker.wage_obligation_settled',
        targetId: e.id,
        metadata: {
          obligationId: o.id,
          kind: o.kind,
          paymentId,
          workerId: e.workerId,
          unitId: e.unitId,
        },
      });
    }
  }

  /** The household's receipt: the payer and the unit's primary, by email. */
  private async receipt(
    tx: TenantTxClient,
    e: WorkerEngagement,
    period: string,
    amount: Prisma.Decimal,
  ): Promise<void> {
    const primary = await tx.unitOccupancy.findFirst({
      where: { unitId: e.unitId, status: 'active', isPrimary: true },
      select: { accountId: true },
    });
    const worker = await tx.domesticWorker.findUniqueOrThrow({
      where: { id: e.workerId },
      select: { fullName: true },
    });
    await this.notifier.toAccounts(
      tx,
      e.tenantId,
      [this.ctx.accountId, ...(primary ? [primary.accountId] : [])],
      COMMUNITY_NOTICES.wagePaid,
      {
        ...(await this.notifier.place(tx, e.tenantId, e.unitId)),
        workerName: worker.fullName,
        period,
        amount: amount.toFixed(2),
      },
    );
  }

  private async payer(tx: TenantTxClient, id: string) {
    return tx.account.findUniqueOrThrow({
      where: { id },
      select: { id: true, fullName: true, status: true },
    });
  }
}

function read(
  p: WorkerWagePayment,
  paidBy: WagePaymentRead['paidBy'],
): WagePaymentRead {
  return {
    id: p.id,
    engagementId: p.engagementId,
    period: p.period.toISOString().slice(0, 7),
    amount: p.amount.toFixed(2),
    paidAt: p.createdAt,
    paidBy,
  };
}

/** A positive amount with at most two decimals, up to MAX_WAGE. */
function checkAmount(
  field: string,
  raw: string | number | null | undefined,
): Prisma.Decimal {
  const invalid = (code: FieldErrorCode, params?: { max: string }) =>
    appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid amount', {
      fields: [{ field, code, ...(params ? { params } : {}) }],
    });
  if (raw === undefined || raw === null || raw === '')
    throw invalid(FieldErrorCode.FIELD_REQUIRED);
  const text = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw invalid(FieldErrorCode.INVALID_NUMBER, { max: MAX_WAGE.toFixed(2) });
  const amount = new Prisma.Decimal(text);
  if (amount.lessThanOrEqualTo(0) || amount.greaterThan(MAX_WAGE))
    throw invalid(FieldErrorCode.INVALID_NUMBER, { max: MAX_WAGE.toFixed(2) });
  return amount;
}

/**
 * `YYYY-MM` (the DTO checked the shape) as the month's first day, not after
 * the compound's current month, not before the engagement's first.
 */
function checkPeriod(period: string, createdAt: Date, timeZone: string): Date {
  const month = (instant: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
    })
      .format(instant)
      .slice(0, 7);
  const fields: FieldError[] = [];
  if (period > month(new Date()))
    fields.push({
      field: 'period',
      code: FieldErrorCode.WAGE_PERIOD_IN_FUTURE,
    });
  else if (period < month(createdAt))
    fields.push({
      field: 'period',
      code: FieldErrorCode.WAGE_PERIOD_BEFORE_ENGAGEMENT,
      params: { first: month(createdAt) },
    });
  if (fields.length)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid period', {
      fields,
    });
  return new Date(`${period}-01T00:00:00.000Z`);
}

function sameAmount(
  a: Prisma.Decimal | null,
  b: Prisma.Decimal | null,
): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

function engagementNotFound() {
  return appError.notFound(
    ErrorCode.ENGAGEMENT_NOT_FOUND,
    'Engagement not found',
  );
}
