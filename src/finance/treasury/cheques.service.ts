import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FinanceCheque } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { FinanceAccess } from '../access';
import { asDate, fromDate } from '../db-clock';
import { money, show } from '../money';
import { FinanceNotices } from '../notices/finance-notices';
import { supersedeLive } from '../online/supersede';
import { PAID_ON_DAYS, PaymentsService } from '../payments/payments.service';
import { CashAccountsService } from './cash-accounts.service';
import { registerCheque } from './cheque-rows';
import type { ChequesQueryDto, ReceiveChequeDto } from './dto/treasury.dto';
import { invalid, TreasuryCommon } from './treasury-common';
import { lockAccounts } from './treasury-locks';
import { CHEQUE_AHEAD_DAYS, CHEQUE_STALE_DAYS } from './treasury-rules';
import type { ChequeView } from './views/treasury.views';

export const CHEQUE_RESOURCE = 'cheque';
export const CHEQUES_SWEEP = 'finance.cheques';
const EVERY = 3_600_000;
const SWEEP_BATCH = 100;
const PAGE = keysetCursor('createdAt');

const chequeNotFound = () =>
  appError.notFound(ErrorCode.CHEQUE_NOT_FOUND, 'Cheque not found');
const wrongState = (status: string) =>
  appError.conflict(ErrorCode.CHEQUE_STATE, 'The cheque has moved on', {
    params: { status },
  });

/**
 * The cheque register (ADR 0085). A cheque dated the day it is received or
 * earlier pays at once as an office payment by cheque (ADR 0046); a
 * post-dated one is held and pays when it is deposited, from its due day
 * — what nothing owes then is the unit's credit, since the money is real.
 * Received → deposited → cleared (its money in the bank account it went
 * to) or bounced (its payment reversed, `bounced_cheque`, so the invoices
 * it paid are owed again); a cheque not yet deposited may be given back
 * (its payment, if it made one, reversed). Every step takes the unit's
 * finance lock, then the cheque FOR UPDATE: a clear and a bounce at once
 * meet there, and the second finds the cheque moved on.
 */
@Injectable()
export class ChequesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: FinanceAccess,
    private readonly community: CommunityFinancePort,
    private readonly payments: PaymentsService,
    private readonly accounts: CashAccountsService,
    private readonly common: TreasuryCommon,
    private readonly notices: FinanceNotices,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(CHEQUE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.read(tx, id)),
    );
    this.sweep.register(CHEQUES_SWEEP, () => this.tellDue(), {
      intervalMs: EVERY,
    });
  }

  receive(unitId: string, dto: ReceiveChequeDto): Promise<ChequeView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CHEQUE_RESOURCE, id });
      await this.access.lockSelf(tx);
      if (!(await this.community.units(tx, [unitId])).has(unitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const today = await this.common.today(tx);
      const fields = [];
      const earliest = addDays(today, -PAID_ON_DAYS);
      if (dto.receivedOn > today || dto.receivedOn < earliest)
        fields.push({
          field: 'receivedOn',
          code: FieldErrorCode.INVALID_VALUE,
          params: { min: earliest, max: today },
        });
      const stale = addDays(today, -CHEQUE_STALE_DAYS);
      const ahead = addDays(today, CHEQUE_AHEAD_DAYS);
      if (dto.dueOn < stale || dto.dueOn > ahead)
        fields.push({
          field: 'dueOn',
          code: FieldErrorCode.INVALID_VALUE,
          params: { min: stale, max: ahead },
        });
      const postDated = dto.dueOn > today;
      if (postDated && dto.invoiceIds !== undefined)
        fields.push({
          field: 'invoiceIds',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      if (fields.length) throw invalid(fields);
      await this.access.lockUnits(tx, [unitId]);
      const amount = money(dto.amount);
      let paymentId: string | null = null;
      if (postDated) {
        // Held: what it will pay is still owed today.
        await this.payments.withinOwed(tx, unitId, [], amount);
      } else {
        paymentId = newId();
        await this.payments.officeLocked(tx, paymentId, unitId, {
          method: 'cheque',
          amount,
          paidOn: dto.receivedOn,
          reference: dto.number,
          named: dto.invoiceIds ?? [],
        });
      }
      await registerCheque(tx, this.audit, {
        id,
        tenantId: this.ctx.txTenantId,
        unitId,
        number: dto.number,
        bankName: dto.bankName?.trim() ?? null,
        amount,
        dueOn: dto.dueOn,
        receivedOn: dto.receivedOn,
        recordedById: this.ctx.accountId,
        paymentId,
      });
      return this.read(tx, id);
    });
  }

  list(q: ChequesQueryDto): Promise<Page<ChequeView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeCheque.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.unitId ? { unitId: q.unitId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.views(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** Into a live bank account, from its due day; a held cheque pays now. */
  deposit(id: string, accountId: string): Promise<ChequeView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const c = await this.locked(tx, id);
      if (c.status !== 'received') throw wrongState(c.status);
      const today = await this.common.today(tx);
      const dueOn = fromDate(c.dueOn);
      if (dueOn > today)
        throw appError.conflict(ErrorCode.CHEQUE_NOT_DUE, 'Not due yet', {
          params: { dueOn },
        });
      await lockAccounts(tx, [accountId], { live: true, kind: 'bank' });
      let paymentId = c.paymentId;
      if (!paymentId) {
        paymentId = newId();
        await supersedeLive(tx, [c.unitId]);
        await this.payments.create(tx, paymentId, {
          unitId: c.unitId,
          channel: 'office',
          method: 'cheque',
          amount: c.amount,
          paidOn: today,
          reference: c.number,
          recordedById: this.ctx.accountId,
          named: [],
        });
      }
      await tx.financeCheque.update({
        where: { id },
        data: {
          status: 'deposited',
          paymentId,
          depositedToAccountId: accountId,
          depositedOn: asDate(today),
          depositedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'cheque.deposited',
        targetId: id,
        metadata: { accountId, paymentId, paidNow: !c.paymentId },
      });
      return this.read(tx, id);
    });
  }

  clear(id: string): Promise<ChequeView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const c = await this.locked(tx, id);
      if (c.status !== 'deposited') throw wrongState(c.status);
      await lockAccounts(tx, [c.depositedToAccountId!], { live: true });
      await this.clearLocked(tx, c, await this.common.today(tx), null);
      return this.read(tx, id);
    });
  }

  /**
   * Clears a deposited cheque whose unit lock, row lock and account lock
   * the caller holds: its money into the account. Shared with a statement
   * line's match.
   */
  async clearLocked(
    tx: TenantTxClient,
    c: FinanceCheque,
    today: LocalDate,
    matchId: string | null,
  ): Promise<void> {
    await this.accounts.insertMovement(tx, {
      accountId: c.depositedToAccountId!,
      kind: 'cheque',
      amount: c.amount,
      onDay: today,
      chequeId: c.id,
    });
    await tx.financeCheque.update({
      where: { id: c.id },
      data: {
        status: 'cleared',
        clearedOn: asDate(today),
        clearedById: this.ctx.accountId,
      },
    });
    await this.audit.record(tx, {
      action: 'cheque.cleared',
      targetId: c.id,
      metadata: {
        accountId: c.depositedToAccountId,
        amount: show(c.amount),
        matchId,
      },
    });
  }

  /** The bank refused it: its payment is reversed and the unit told. */
  bounce(id: string, reasonCode: string | undefined): Promise<ChequeView> {
    const reason = requireReasonCodeOnly(reasonCode, REASON_CODES.chequeBounce);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const c = await this.locked(tx, id);
      if (c.status !== 'deposited') throw wrongState(c.status);
      const reversed = await this.reversePayment(tx, c, 'bounced_cheque');
      const today = await this.common.today(tx);
      await tx.financeCheque.update({
        where: { id },
        data: {
          status: 'bounced',
          bouncedOn: asDate(today),
          bouncedById: this.ctx.accountId,
          bounceReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'cheque.bounced',
        targetId: id,
        metadata: {
          reasonCode: reason,
          paymentId: c.paymentId,
          reversalId: reversed,
        },
      });
      if (reversed)
        await this.notices.toUnit(tx, c.unitId, 'cheque.bounced', c.paymentId!);
      return this.read(tx, id);
    });
  }

  /** Given back before it was deposited; a payment it made is reversed. */
  giveBack(id: string, reasonCode: string | undefined): Promise<ChequeView> {
    const reason = requireReasonCodeOnly(reasonCode, REASON_CODES.chequeReturn);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const c = await this.locked(tx, id);
      if (c.status !== 'received') throw wrongState(c.status);
      const reversed = await this.reversePayment(tx, c, 'other');
      const today = await this.common.today(tx);
      await tx.financeCheque.update({
        where: { id },
        data: {
          status: 'returned',
          returnedOn: asDate(today),
          returnedById: this.ctx.accountId,
          returnReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'cheque.returned',
        targetId: id,
        metadata: {
          reasonCode: reason,
          paymentId: c.paymentId,
          reversalId: reversed,
        },
      });
      return this.read(tx, id);
    });
  }

  /**
   * The sweep: a held cheque whose due day came is told once to who keeps
   * payments — the row claimed first (SKIP LOCKED), so two runs tell once.
   */
  tellDue(): Promise<number> {
    return this.sweep.forEachTenant(async (tx, tenantId) => {
      const today = await this.common.today(tx, tenantId);
      const due = await tx.$queryRaw<{ id: string; due_on: Date }[]>`
        UPDATE finance_cheques SET due_notified_at = now()
         WHERE id IN (SELECT id FROM finance_cheques
                       WHERE status = 'received' AND payment_id IS NULL
                         AND due_notified_at IS NULL AND due_on <= ${today}::date
                       ORDER BY due_on, id LIMIT ${SWEEP_BATCH}
                       FOR UPDATE SKIP LOCKED)
        RETURNING id, due_on`;
      if (!due.length) return 0;
      const to = (await this.staff.holding(tx, 'finance.payments')).map(
        (r) => r.id,
      );
      for (const d of due)
        if (to.length)
          await this.notifier.notify(tx, to, {
            kind: 'cheque.due',
            params: { dueOn: fromDate(d.due_on) },
            targetId: d.id,
          });
      return due.length;
    });
  }

  /** The cheque's unit's finance lock, then the cheque FOR UPDATE. */
  async locked(tx: TenantTxClient, id: string): Promise<FinanceCheque> {
    const first = await tx.financeCheque.findUnique({
      where: { id },
      select: { unitId: true },
    });
    if (!first) throw chequeNotFound();
    await this.access.lockUnits(tx, [first.unitId]);
    await tx.$queryRaw`SELECT id FROM finance_cheques WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.financeCheque.findUniqueOrThrow({ where: { id } });
  }

  /** The cheque's live payment reversed through the payments' own path; its id. */
  private async reversePayment(
    tx: TenantTxClient,
    c: FinanceCheque,
    reasonCode: 'bounced_cheque' | 'other',
  ): Promise<string | null> {
    if (!c.paymentId) return null;
    const already = await tx.financePayment.findFirst({
      where: { reversesId: c.paymentId },
      select: { id: true },
    });
    if (already) return null;
    const reversalId = newId();
    await this.payments.reverseInTx(tx, reversalId, c.paymentId, reasonCode);
    return reversalId;
  }

  async read(tx: TenantTxClient, id: string): Promise<ChequeView> {
    const row = await tx.financeCheque.findUnique({ where: { id } });
    if (!row) throw chequeNotFound();
    return (await this.views(tx, [row]))[0];
  }

  private async views(
    tx: TenantTxClient,
    rows: readonly FinanceCheque[],
  ): Promise<ChequeView[]> {
    if (!rows.length) return [];
    const units = await this.community.units(
      tx,
      rows.map((r) => r.unitId),
    );
    const ref = await this.common.refs(
      tx,
      rows.map((r) => r.recordedById),
    );
    const paymentIds = rows.flatMap((r) => (r.paymentId ? [r.paymentId] : []));
    const reversed = new Set(
      (
        await tx.financePayment.findMany({
          where: { reversesId: { in: paymentIds } },
          select: { reversesId: true },
        })
      ).map((r) => r.reversesId),
    );
    const day = (d: Date | null) => (d ? fromDate(d) : null);
    return rows.map((c) => ({
      id: c.id,
      unitId: c.unitId,
      unitCode: units.get(c.unitId)?.code ?? '',
      number: c.number,
      bankName: c.bankName,
      amount: show(c.amount),
      dueOn: fromDate(c.dueOn),
      receivedOn: fromDate(c.receivedOn),
      postDated: c.dueOn.getTime() > c.receivedOn.getTime(),
      status: c.status,
      paymentId: c.paymentId,
      paymentReversed: c.paymentId !== null && reversed.has(c.paymentId),
      depositedToAccountId: c.depositedToAccountId,
      depositedOn: day(c.depositedOn),
      clearedOn: day(c.clearedOn),
      bouncedOn: day(c.bouncedOn),
      bounceReason: c.bounceReason,
      returnedOn: day(c.returnedOn),
      returnReason: c.returnReason,
      recordedBy: ref(c.recordedById),
      createdAt: c.createdAt,
    }));
  }
}
