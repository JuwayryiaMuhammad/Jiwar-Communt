import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceCustodyHandin,
  type FinanceCustodyInvestigation,
} from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { PermissionsService } from '../../core/access/permissions.service';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, dbNow, fromDate } from '../db-clock';
import { money, show, ZERO } from '../money';
import { CashAccountsService } from './cash-accounts.service';
import type {
  CustodyHandinDto,
  CustodyOutcomeDto,
  HandinsQueryDto,
  InvestigationsQueryDto,
  OpenInvestigationDto,
} from './dto/treasury.dto';
import { invalid, TreasuryCommon } from './treasury-common';
import { lockAccounts, lockCustody } from './treasury-locks';
import { INVESTIGATION_MAX_DAYS } from './treasury-rules';
import type {
  CustodyHandinDetailView,
  CustodyHandinView,
  CustodyInvestigationView,
  CustodyPaymentView,
  CustodySummaryView,
  CustodyView,
} from './views/treasury.views';

export const HANDIN_RESOURCE = 'custody_handin';
const HANDINS = keysetCursor('createdAt');
const INVESTIGATIONS = keysetCursor('openedAt');
const PAYMENTS_SHOWN = 500;
const HANDINS_SHOWN = 20;
const HOUR_MS = 3_600_000;

/**
 * A custodian's open custody (ADR 0085): the office cash payments they
 * recorded since custody began, not reversed and in no hand-in. Read from
 * the payments, never copied.
 */
export const OPEN_CUSTODY = Prisma.sql`
  p.kind = 'payment' AND p.channel = 'office' AND p.method = 'cash'
  AND p.recorded_by_account_id IS NOT NULL
  AND p.created_at >= (SELECT s.custody_from FROM finance_settings s WHERE s.tenant_id = p.tenant_id)
  AND NOT EXISTS (SELECT 1 FROM finance_payments r
                   WHERE r.tenant_id = p.tenant_id AND r.reverses_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM finance_custody_handin_items i
                   WHERE i.tenant_id = p.tenant_id AND i.payment_id = p.id)`;

const custodianNotFound = () =>
  appError.notFound(ErrorCode.CUSTODIAN_NOT_FOUND, 'Custodian not found');
const handinNotFound = () =>
  appError.notFound(ErrorCode.CUSTODY_HANDIN_NOT_FOUND, 'Hand-in not found');
const investigationNotFound = () =>
  appError.notFound(
    ErrorCode.CUSTODY_INVESTIGATION_NOT_FOUND,
    'Investigation not found',
  );
const conflict = () =>
  appError.forbidden(
    ErrorCode.CUSTODY_CONFLICT,
    'Nobody receives or settles their own custody',
  );

/**
 * Collectors' and cashiers' custody (ADR 0085, the owner's decision C1).
 * A hand-in, recorded by a `finance.payments` holder who is not the
 * custodian, takes every open payment at once into a cash box, against
 * the expected amount the receiver was shown (`CUSTODY_CHANGED` when a
 * payment landed or was reversed meanwhile), with what was counted. A
 * count that differs is a variance with its reason: the critical notice
 * goes to `finance.custody`, and the hand-in stays open until settled —
 * by a `finance.custody` holder, or through an investigation with an
 * owner, a due day and an outcome. Nobody settles their own.
 *
 * Locks: the caller FOR SHARE; the custodian's custody lock (the payment
 * paths take it before they write their cash payment or its reversal, so
 * the hand-in sees each whole or not at all); then the cash box. Settling:
 * the hand-in FOR UPDATE, its investigation, then the cash box.
 */
@Injectable()
export class CustodyService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: FinanceAccess,
    private readonly community: CommunityFinancePort,
    private readonly accounts: CashAccountsService,
    private readonly common: TreasuryCommon,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly permissions: PermissionsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(HANDIN_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.detailIn(tx, id)),
    );
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** Everyone's open custody and unsettled variances, the oldest first. */
  summary(): Promise<CustodySummaryView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const open = await tx.$queryRaw<
        { custodian: string; n: number; total: Prisma.Decimal; oldest: Date }[]
      >`
        SELECT p.recorded_by_account_id AS custodian, count(*)::int AS n,
               SUM(p.amount) AS total, MIN(p.created_at) AS oldest
          FROM finance_payments p WHERE ${OPEN_CUSTODY}
         GROUP BY p.recorded_by_account_id`;
      const variances = await tx.financeCustodyHandin.groupBy({
        by: ['custodianId'],
        where: { status: 'variance' },
        _count: { _all: true },
      });
      const ids = [
        ...new Set([
          ...open.map((o) => o.custodian),
          ...variances.map((v) => v.custodianId),
        ]),
      ];
      const ref = await this.common.refs(tx, ids);
      const now = await dbNow(tx);
      return ids
        .map((id) => {
          const o = open.find((x) => x.custodian === id);
          return {
            custodian: ref(id),
            openCount: o?.n ?? 0,
            expected: show(o?.total ?? ZERO),
            oldestAt: o?.oldest ?? null,
            ageHours: o
              ? Math.floor((now.getTime() - o.oldest.getTime()) / HOUR_MS)
              : null,
            unresolvedVariances:
              variances.find((v) => v.custodianId === id)?._count._all ?? 0,
          };
        })
        .sort(
          (a, b) =>
            (a.oldestAt?.getTime() ?? Infinity) -
              (b.oldestAt?.getTime() ?? Infinity) ||
            (a.custodian.id < b.custodian.id ? -1 : 1),
        );
    });
  }

  /** One custodian's custody: their open payments and latest hand-ins. */
  custody(accountId: string): Promise<CustodyView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await this.common.isStaff(tx, accountId)))
        throw custodianNotFound();
      return this.custodyIn(tx, accountId);
    });
  }

  /** The caller's own custody (a collector's): no other name in it. */
  mine(): Promise<CustodyView> {
    return this.tenantTx.withTenantTx((tx) =>
      this.custodyIn(tx, this.ctx.accountId),
    );
  }

  handins(q: HandinsQueryDto): Promise<Page<CustodyHandinView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeCustodyHandin.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.custodianId ? { custodianId: q.custodianId } : {},
            ...HANDINS.after(q.cursor),
          ],
        },
        orderBy: HANDINS.orderBy,
        take: limit + 1,
      });
      const page = HANDINS.toPage(rows, limit);
      return {
        items: await this.views(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  handin(id: string): Promise<CustodyHandinDetailView> {
    return this.tenantTx.withTenantTx((tx) => this.detailIn(tx, id));
  }

  /**
   * Investigations: every one to a `finance.custody` holder; to anyone
   * else (a `finance.payments` holder), only those they own.
   */
  investigations(
    q: InvestigationsQueryDto,
  ): Promise<Page<CustodyInvestigationView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const all = await this.permissions.has('finance.custody');
      const rows = await tx.financeCustodyInvestigation.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            all ? {} : { ownerId: this.ctx.accountId },
            ...INVESTIGATIONS.after(q.cursor),
          ],
        },
        orderBy: INVESTIGATIONS.orderBy,
        take: limit + 1,
      });
      const page = INVESTIGATIONS.toPage(rows, limit);
      return {
        items: await this.investigationViews(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /** Every open payment of the custodian at once, into a cash box. */
  handIn(
    custodianId: string,
    dto: CustodyHandinDto,
  ): Promise<CustodyHandinDetailView> {
    const expectedSeen = money(dto.expected);
    const counted = money(dto.counted);
    const variance = counted.sub(expectedSeen);
    const reasons = REASON_CODES.custodyVariance as readonly string[];
    if (variance.isZero() && dto.varianceReason !== undefined)
      throw invalid([
        { field: 'varianceReason', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    if (!variance.isZero() && dto.varianceReason === undefined)
      throw invalid([
        { field: 'varianceReason', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    if (
      dto.varianceReason !== undefined &&
      !reasons.includes(dto.varianceReason)
    )
      throw invalid([
        {
          field: 'varianceReason',
          code: FieldErrorCode.INVALID_REASON_CODE,
          params: { allowed: [...reasons] },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: HANDIN_RESOURCE, id });
      await this.access.lockSelf(tx);
      if (!(await this.common.isStaff(tx, custodianId)))
        throw custodianNotFound();
      if (custodianId === this.ctx.accountId) throw conflict();
      const tenantId = this.ctx.txTenantId;
      await lockCustody(tx, tenantId, custodianId);
      const open = await tx.$queryRaw<{ id: string; amount: Prisma.Decimal }[]>`
        SELECT p.id, p.amount FROM finance_payments p
         WHERE p.recorded_by_account_id = ${custodianId}::uuid AND ${OPEN_CUSTODY}
         ORDER BY p.created_at, p.id`;
      if (!open.length)
        throw appError.conflict(ErrorCode.CUSTODY_EMPTY, 'Nothing to hand in');
      const expected = open.reduce((sum, p) => sum.add(p.amount), ZERO);
      if (!expected.eq(expectedSeen))
        throw appError.conflict(
          ErrorCode.CUSTODY_CHANGED,
          'The custody changed since it was counted',
          { params: { expected: show(expected) } },
        );
      await lockAccounts(tx, [dto.cashAccountId], { live: true, kind: 'cash' });
      const today = await this.common.today(tx);
      const number = await takeNumbers(tx, tenantId, 'handin');
      const createdAt = await dbNow(tx);
      await tx.financeCustodyHandin.create({
        data: {
          id,
          tenantId,
          number,
          custodianId,
          receivedById: this.ctx.accountId,
          cashAccountId: dto.cashAccountId,
          expected,
          counted,
          variance,
          varianceReason: dto.varianceReason ?? null,
          paymentCount: open.length,
          receivedOn: asDate(today),
          createdAt,
          status: variance.isZero() ? 'balanced' : 'variance',
        },
      });
      await tx.financeCustodyHandinItem.createMany({
        data: open.map((p) => ({
          tenantId,
          paymentId: p.id,
          handinId: id,
          amount: p.amount,
        })),
      });
      if (counted.gt(ZERO))
        await this.accounts.insertMovement(tx, {
          accountId: dto.cashAccountId,
          kind: 'handin',
          amount: counted,
          onDay: today,
          handinId: id,
        });
      await this.audit.record(tx, {
        action: 'custody_handin.recorded',
        targetId: id,
        metadata: {
          custodianId,
          cashAccountId: dto.cashAccountId,
          expected: show(expected),
          counted: show(counted),
          variance: show(variance),
          ...(dto.varianceReason ? { varianceReason: dto.varianceReason } : {}),
          paymentCount: open.length,
        },
      });
      if (!variance.isZero()) {
        const to = (await this.staff.holding(tx, 'finance.custody'))
          .map((r) => r.id)
          .filter((r) => r !== custodianId);
        if (to.length)
          await this.notifier.notify(tx, to, {
            kind: 'finance.custody_variance',
            params: { handinNumber: formatNumber('handin', number) },
            targetId: id,
          });
      }
      return this.detailIn(tx, id);
    });
  }

  /** A variance settled without an investigation (`finance.custody`). */
  resolve(
    id: string,
    dto: CustodyOutcomeDto,
  ): Promise<CustodyHandinDetailView> {
    const outcome = requireReasonCodeOnly(
      dto.reasonCode,
      REASON_CODES.custodyOutcome,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const h = await this.lockedHandin(tx, id);
      if (h.status !== 'variance')
        throw appError.conflict(
          ErrorCode.CUSTODY_HANDIN_NOT_OPEN,
          'No variance to settle',
          {
            params: { status: h.status },
          },
        );
      if (h.custodianId === this.ctx.accountId) throw conflict();
      const inv = await tx.financeCustodyInvestigation.findUnique({
        where: { tenantId_handinId: { tenantId: h.tenantId, handinId: id } },
        select: { id: true },
      });
      if (inv)
        throw appError.conflict(
          ErrorCode.CUSTODY_INVESTIGATION_OPEN,
          'Settled through its investigation',
          { params: { investigationId: inv.id } },
        );
      await this.settle(tx, h, outcome, dto.recoveredAmount, null);
      return this.detailIn(tx, id);
    });
  }

  /** An investigation of a variance, with an owner and a due day. */
  investigate(
    id: string,
    dto: OpenInvestigationDto,
  ): Promise<CustodyHandinDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const h = await this.lockedHandin(tx, id);
      if (h.status !== 'variance')
        throw appError.conflict(
          ErrorCode.CUSTODY_HANDIN_NOT_OPEN,
          'No variance to investigate',
          {
            params: { status: h.status },
          },
        );
      if (h.custodianId === this.ctx.accountId) throw conflict();
      const existing = await tx.financeCustodyInvestigation.findUnique({
        where: { tenantId_handinId: { tenantId: h.tenantId, handinId: id } },
        select: { id: true },
      });
      if (existing)
        throw appError.conflict(
          ErrorCode.CUSTODY_INVESTIGATION_OPEN,
          'Investigated already',
          {
            params: { investigationId: existing.id },
          },
        );
      const today = await this.common.today(tx);
      const max = addDays(today, INVESTIGATION_MAX_DAYS);
      const fields = [];
      if (
        dto.ownerId === h.custodianId ||
        !(await this.mayOwn(tx, dto.ownerId))
      )
        fields.push({ field: 'ownerId', code: FieldErrorCode.INVALID_VALUE });
      if (dto.dueOn < today || dto.dueOn > max)
        fields.push({
          field: 'dueOn',
          code: FieldErrorCode.INVALID_VALUE,
          params: { min: today, max },
        });
      if (fields.length) throw invalid(fields);
      const invId = newId();
      await tx.financeCustodyInvestigation.create({
        data: {
          id: invId,
          tenantId: h.tenantId,
          handinId: id,
          ownerId: dto.ownerId,
          dueOn: asDate(dto.dueOn),
          openedById: this.ctx.accountId,
          openedAt: await dbNow(tx),
          status: 'open',
        },
      });
      await this.audit.record(tx, {
        action: 'custody_investigation.opened',
        targetId: invId,
        metadata: { handinId: id, ownerId: dto.ownerId, dueOn: dto.dueOn },
      });
      await this.notifier.notify(tx, [dto.ownerId], {
        kind: 'finance.custody_investigation_assigned',
        params: {
          handinNumber: formatNumber('handin', h.number),
          dueOn: dto.dueOn,
        },
        targetId: invId,
      });
      return this.detailIn(tx, id);
    });
  }

  /** Its owner or a `finance.custody` holder decides it; never the custodian. */
  decide(
    invId: string,
    dto: CustodyOutcomeDto,
  ): Promise<CustodyInvestigationView> {
    const outcome = requireReasonCodeOnly(
      dto.reasonCode,
      REASON_CODES.custodyOutcome,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const first = await tx.financeCustodyInvestigation.findUnique({
        where: { id: invId },
        select: { handinId: true, ownerId: true },
      });
      const keeper = await this.permissions.has('finance.custody');
      if (!first || (!keeper && first.ownerId !== this.ctx.accountId))
        throw investigationNotFound();
      const h = await this.lockedHandin(tx, first.handinId);
      await tx.$queryRaw`SELECT id FROM finance_custody_investigations WHERE id = ${invId}::uuid FOR UPDATE`;
      const inv = await tx.financeCustodyInvestigation.findUniqueOrThrow({
        where: { id: invId },
      });
      if (inv.status !== 'open')
        throw appError.conflict(
          ErrorCode.CUSTODY_INVESTIGATION_DECIDED,
          'Decided already',
        );
      if (h.custodianId === this.ctx.accountId) throw conflict();
      const recovered = await this.settle(
        tx,
        h,
        outcome,
        dto.recoveredAmount,
        invId,
      );
      await tx.financeCustodyInvestigation.update({
        where: { id: invId },
        data: {
          status: 'decided',
          outcome,
          recovered,
          decidedById: this.ctx.accountId,
          decidedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'custody_investigation.decided',
        targetId: invId,
        metadata: {
          handinId: h.id,
          outcome,
          ...(recovered ? { recovered: show(recovered) } : {}),
        },
      });
      const after = await tx.financeCustodyInvestigation.findUniqueOrThrow({
        where: { id: invId },
      });
      return (await this.investigationViews(tx, [after]))[0];
    });
  }

  // --------------------------------------------------------------------------

  /**
   * Settles a variance under the hand-in's lock: `recovered` only of a
   * shortage, never beyond it, into the hand-in's cash box. What was
   * recovered.
   */
  private async settle(
    tx: TenantTxClient,
    h: FinanceCustodyHandin,
    outcome: string,
    recoveredAmount: string | undefined,
    investigationId: string | null,
  ): Promise<Prisma.Decimal | null> {
    const shortage = h.variance.neg();
    if ((outcome === 'recovered') !== (recoveredAmount !== undefined))
      throw invalid([
        {
          field: 'recoveredAmount',
          code:
            outcome === 'recovered'
              ? FieldErrorCode.FIELD_REQUIRED
              : FieldErrorCode.FIELD_NOT_ALLOWED,
        },
      ]);
    const recovered =
      recoveredAmount === undefined ? null : money(recoveredAmount);
    if (recovered && (shortage.lte(ZERO) || recovered.gt(shortage)))
      throw invalid([
        {
          field: 'recoveredAmount',
          code: FieldErrorCode.INVALID_VALUE,
          params: { max: show(shortage.gt(ZERO) ? shortage : ZERO) },
        },
      ]);
    if (recovered) {
      await lockAccounts(tx, [h.cashAccountId], { live: true });
      await this.accounts.insertMovement(tx, {
        accountId: h.cashAccountId,
        kind: 'recovery',
        amount: recovered,
        onDay: await this.common.today(tx),
        handinId: h.id,
      });
    }
    await tx.financeCustodyHandin.update({
      where: { id: h.id },
      data: {
        status: 'resolved',
        outcome,
        recovered,
        resolvedById: this.ctx.accountId,
        resolvedAt: await dbNow(tx),
      },
    });
    await this.audit.record(tx, {
      action: 'custody_handin.resolved',
      targetId: h.id,
      metadata: {
        outcome,
        ...(recovered ? { recovered: show(recovered) } : {}),
        ...(investigationId ? { investigationId } : {}),
      },
    });
    return recovered;
  }

  /** An active staff account holding finance.custody or finance.payments. */
  private async mayOwn(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<boolean> {
    for (const p of ['finance.custody', 'finance.payments'] as const)
      if ((await this.staff.holding(tx, p)).some((r) => r.id === accountId))
        return true;
    return false;
  }

  private async lockedHandin(
    tx: TenantTxClient,
    id: string,
  ): Promise<FinanceCustodyHandin> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM finance_custody_handins WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw handinNotFound();
    return tx.financeCustodyHandin.findUniqueOrThrow({ where: { id } });
  }

  private async custodyIn(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<CustodyView> {
    const [agg] = await tx.$queryRaw<
      { n: number; total: Prisma.Decimal | null; oldest: Date | null }[]
    >`
      SELECT count(*)::int AS n, SUM(p.amount) AS total, MIN(p.created_at) AS oldest
        FROM finance_payments p
       WHERE p.recorded_by_account_id = ${accountId}::uuid AND ${OPEN_CUSTODY}`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM finance_payments p
       WHERE p.recorded_by_account_id = ${accountId}::uuid AND ${OPEN_CUSTODY}
       ORDER BY p.created_at, p.id LIMIT ${PAYMENTS_SHOWN}`;
    const handins = await tx.financeCustodyHandin.findMany({
      where: { custodianId: accountId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HANDINS_SHOWN,
    });
    const ref = await this.common.refs(tx, [accountId]);
    const now = await dbNow(tx);
    return {
      custodian: ref(accountId),
      expected: show(agg.total ?? ZERO),
      openCount: agg.n,
      oldestAt: agg.oldest,
      ageHours: agg.oldest
        ? Math.floor((now.getTime() - agg.oldest.getTime()) / HOUR_MS)
        : null,
      payments: await this.paymentViews(
        tx,
        rows.map((r) => r.id),
      ),
      handins: await this.views(tx, handins),
    };
  }

  private async paymentViews(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<CustodyPaymentView[]> {
    if (!ids.length) return [];
    const rows = await tx.financePayment.findMany({
      where: { id: { in: [...ids] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const units = await this.community.units(
      tx,
      rows.map((r) => r.unitId),
    );
    return rows.map((p) => ({
      paymentId: p.id,
      receiptNumber: formatNumber('receipt', p.receiptNumber!),
      unitId: p.unitId,
      unitCode: units.get(p.unitId)?.code ?? '',
      amount: show(p.amount!),
      paidOn: fromDate(p.paidOn!),
      createdAt: p.createdAt,
    }));
  }

  private async detailIn(
    tx: TenantTxClient,
    id: string,
  ): Promise<CustodyHandinDetailView> {
    const h = await tx.financeCustodyHandin.findUnique({ where: { id } });
    if (!h) throw handinNotFound();
    const [view] = await this.views(tx, [h]);
    const items = await tx.financeCustodyHandinItem.findMany({
      where: { handinId: id },
      select: { paymentId: true },
    });
    const inv = await tx.financeCustodyInvestigation.findUnique({
      where: { tenantId_handinId: { tenantId: h.tenantId, handinId: id } },
    });
    return {
      ...view,
      payments: await this.paymentViews(
        tx,
        items.map((i) => i.paymentId),
      ),
      investigation: inv ? (await this.investigationViews(tx, [inv]))[0] : null,
    };
  }

  private async views(
    tx: TenantTxClient,
    rows: readonly FinanceCustodyHandin[],
  ): Promise<CustodyHandinView[]> {
    if (!rows.length) return [];
    const ref = await this.common.refs(
      tx,
      rows.flatMap((h) => [h.custodianId, h.receivedById, h.resolvedById]),
    );
    const invs = await tx.financeCustodyInvestigation.findMany({
      where: { handinId: { in: rows.map((h) => h.id) } },
      select: { id: true, handinId: true },
    });
    return rows.map((h) => ({
      id: h.id,
      number: formatNumber('handin', h.number),
      custodian: ref(h.custodianId),
      receivedBy: ref(h.receivedById),
      cashAccountId: h.cashAccountId,
      expected: show(h.expected),
      counted: show(h.counted),
      variance: show(h.variance),
      varianceReason: h.varianceReason,
      paymentCount: h.paymentCount,
      receivedOn: fromDate(h.receivedOn),
      status: h.status,
      outcome: h.outcome,
      recovered: h.recovered ? show(h.recovered) : null,
      resolvedBy: h.resolvedById ? ref(h.resolvedById) : null,
      resolvedAt: h.resolvedAt,
      investigationId: invs.find((i) => i.handinId === h.id)?.id ?? null,
      createdAt: h.createdAt,
    }));
  }

  private async investigationViews(
    tx: TenantTxClient,
    rows: readonly FinanceCustodyInvestigation[],
  ): Promise<CustodyInvestigationView[]> {
    if (!rows.length) return [];
    const ref = await this.common.refs(
      tx,
      rows.flatMap((i) => [i.ownerId, i.openedById, i.decidedById]),
    );
    const numbers = new Map(
      (
        await tx.financeCustodyHandin.findMany({
          where: { id: { in: rows.map((i) => i.handinId) } },
          select: { id: true, number: true },
        })
      ).map((h) => [h.id, h.number]),
    );
    const today = await this.common.today(tx);
    return rows.map((i) => ({
      id: i.id,
      handinId: i.handinId,
      handinNumber: formatNumber('handin', numbers.get(i.handinId) ?? 0),
      owner: ref(i.ownerId),
      dueOn: fromDate(i.dueOn),
      overdue: i.status === 'open' && fromDate(i.dueOn) < today,
      status: i.status,
      outcome: i.outcome,
      recovered: i.recovered ? show(i.recovered) : null,
      openedBy: ref(i.openedById),
      openedAt: i.openedAt,
      decidedBy: i.decidedById ? ref(i.decidedById) : null,
      decidedAt: i.decidedAt,
    }));
  }
}
