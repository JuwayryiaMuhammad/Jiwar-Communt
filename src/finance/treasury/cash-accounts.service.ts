import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceCashAccount,
  type FinanceCashMovement,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
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
import { FinanceAccess } from '../access';
import { asDate, fromDate } from '../db-clock';
import { money, show, ZERO } from '../money';
import type {
  CashAdjustmentDto,
  CashTransferDto,
  CreateCashAccountDto,
  UpdateCashAccountDto,
} from './dto/treasury.dto';
import { invalid, TreasuryCommon } from './treasury-common';
import { accountNotFound, lockAccounts } from './treasury-locks';
import { MAX_SIGNED, MOVEMENT_DAYS_BACK } from './treasury-rules';
import type {
  CashAccountView,
  CashMovementView,
  CashTransferView,
} from './views/treasury.views';

export const CASH_TRANSFER_RESOURCE = 'cash_transfer';
export const CASH_ADJUSTMENT_RESOURCE = 'cash_adjustment';
const PAGE = keysetCursor('createdAt');

/** What a new movement is; its account is locked by the caller. */
export interface NewMovement {
  accountId: string;
  kind: string;
  amount: Prisma.Decimal;
  onDay: LocalDate;
  handinId?: string;
  transferId?: string;
  chequeId?: string;
  matchId?: string;
  reversesId?: string;
  reasonCode?: string;
  payoutId?: string;
  taxPaymentId?: string;
}

/** Each account's balance: the sum of its movements. */
export async function balancesOf(
  tx: TenantTxClient,
  ids: readonly string[],
): Promise<Map<string, Prisma.Decimal>> {
  if (!ids.length) return new Map();
  const rows = await tx.financeCashMovement.groupBy({
    by: ['accountId'],
    where: { accountId: { in: [...ids] } },
    _sum: { amount: true },
  });
  return new Map(
    ids.map((id) => [
      id,
      money(rows.find((r) => r.accountId === id)?._sum.amount ?? 0),
    ]),
  );
}

/**
 * The compound's bank and cash accounts (ADR 0085): registers whose
 * balance is the sum of their append-only movements, never stored and
 * never a ledger. Every writer locks its accounts FOR UPDATE (in id
 * order, after any unit, cheque or custody lock it needs), so two writers
 * never decide on the same balance: a cash box never goes below zero.
 */
@Injectable()
export class CashAccountsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly access: FinanceAccess,
    private readonly common: TreasuryCommon,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(CASH_TRANSFER_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.transferView(tx, id)),
    );
    this.idempotency.renderer(CASH_ADJUSTMENT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const m = await tx.financeCashMovement.findUniqueOrThrow({
          where: { id },
        });
        return (await this.movementViews(tx, [m]))[0];
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Accounts
  // --------------------------------------------------------------------------

  list(includeRetired: boolean): Promise<CashAccountView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeCashAccount.findMany({
        where: includeRetired ? {} : { retiredAt: null },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        take: 200,
      });
      return this.views(tx, rows);
    });
  }

  get(id: string): Promise<CashAccountView> {
    return this.tenantTx.withTenantTx((tx) => this.getIn(tx, id));
  }

  create(dto: CreateCashAccountDto): Promise<CashAccountView> {
    if (dto.kind === 'cash') {
      const bad = (['bankName', 'numberLast4'] as const).filter(
        (f) => dto[f] !== undefined,
      );
      if (bad.length)
        throw invalid(
          bad.map((field) => ({
            field,
            code: FieldErrorCode.FIELD_NOT_ALLOWED,
          })),
        );
    }
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const today = await this.common.today(tx);
      if (dto.openedOn > today)
        throw invalid([
          {
            field: 'openedOn',
            code: FieldErrorCode.INVALID_VALUE,
            params: { max: today },
          },
        ]);
      const id = newId();
      await tx.financeCashAccount.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          kind: dto.kind,
          name: dto.name.trim(),
          bankName: dto.bankName?.trim() ?? null,
          numberLast4: dto.numberLast4 ?? null,
          openedOn: asDate(dto.openedOn),
          createdById: this.ctx.accountId,
        },
      });
      const opening = dto.openingBalance ? money(dto.openingBalance) : ZERO;
      if (opening.gt(ZERO))
        await this.insertMovement(tx, {
          accountId: id,
          kind: 'opening',
          amount: opening,
          onDay: dto.openedOn,
        });
      await this.audit.record(tx, {
        action: 'cash_account.created',
        targetId: id,
        metadata: {
          kind: dto.kind,
          openingBalance: show(opening),
          openedOn: dto.openedOn,
        },
      });
      return this.getIn(tx, id);
    });
  }

  update(id: string, dto: UpdateCashAccountDto): Promise<CashAccountView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = (await lockAccounts(tx, [id], { live: true })).get(id)!;
      if (before.kind === 'cash') {
        const bad = (['bankName', 'numberLast4'] as const).filter(
          (f) => dto[f] !== undefined,
        );
        if (bad.length)
          throw invalid(
            bad.map((field) => ({
              field,
              code: FieldErrorCode.FIELD_NOT_ALLOWED,
            })),
          );
      }
      const after = await tx.financeCashAccount.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.bankName !== undefined
            ? { bankName: dto.bankName.trim() }
            : {}),
          ...(dto.numberLast4 !== undefined
            ? { numberLast4: dto.numberLast4 }
            : {}),
        },
      });
      const facts = (a: FinanceCashAccount) => ({
        name: a.name,
        bankName: a.bankName,
        numberLast4: a.numberLast4,
      });
      await this.audit.record(tx, {
        action: 'cash_account.updated',
        targetId: id,
        changes: diffChanges(
          facts(before),
          facts(after),
          'cash_account.updated',
        ),
      });
      return this.getIn(tx, id);
    });
  }

  /** Retired at a zero balance, with no cheque deposited to it pending. */
  retire(id: string): Promise<CashAccountView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await lockAccounts(tx, [id], { live: true });
      const balance = (await balancesOf(tx, [id])).get(id)!;
      const pending = await tx.financeCheque.count({
        where: { depositedToAccountId: id, status: 'deposited' },
      });
      if (!balance.isZero() || pending)
        throw appError.conflict(
          ErrorCode.CASH_ACCOUNT_NOT_EMPTY,
          'Retired only at a zero balance, with no cheque pending',
          { params: { balance: show(balance), pendingCheques: pending } },
        );
      await tx.financeCashAccount.update({
        where: { id },
        data: { retiredAt: new Date(), retiredById: this.ctx.accountId },
      });
      await this.audit.record(tx, {
        action: 'cash_account.retired',
        targetId: id,
      });
      return this.getIn(tx, id);
    });
  }

  // --------------------------------------------------------------------------
  // Movements
  // --------------------------------------------------------------------------

  movements(q: {
    accountId?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<CashMovementView>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeCashMovement.findMany({
        where: {
          AND: [
            q.accountId ? { accountId: q.accountId } : {},
            q.from ? { onDay: { gte: asDate(q.from) } } : {},
            q.to ? { onDay: { lte: asDate(q.to) } } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.movementViews(tx, page.items),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** Money from one account to another; a cash box never below zero. */
  transfer(dto: CashTransferDto): Promise<CashTransferView> {
    if (dto.fromAccountId === dto.toAccountId)
      throw invalid([
        { field: 'toAccountId', code: FieldErrorCode.INVALID_VALUE },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CASH_TRANSFER_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.dayInRange(tx, dto.onDay);
      const accounts = await lockAccounts(
        tx,
        [dto.fromAccountId, dto.toAccountId],
        { live: true },
      );
      const amount = money(dto.amount);
      await this.holds(tx, accounts.get(dto.fromAccountId)!, amount);
      await this.insertMovement(tx, {
        accountId: dto.fromAccountId,
        kind: 'transfer',
        amount: amount.neg(),
        onDay: dto.onDay,
        transferId: id,
      });
      await this.insertMovement(tx, {
        accountId: dto.toAccountId,
        kind: 'transfer',
        amount,
        onDay: dto.onDay,
        transferId: id,
      });
      await this.audit.record(tx, {
        action: 'cash_transfer.recorded',
        targetId: id,
        metadata: {
          fromAccountId: dto.fromAccountId,
          toAccountId: dto.toAccountId,
          amount: show(amount),
          onDay: dto.onDay,
        },
      });
      return this.transferView(tx, id);
    });
  }

  /** An account's balance adjusted by hand, with a reason code. */
  adjust(accountId: string, dto: CashAdjustmentDto): Promise<CashMovementView> {
    const reasonCode = requireReasonCodeOnly(
      dto.reasonCode,
      REASON_CODES.cashAdjust,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: CASH_ADJUSTMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      await this.dayInRange(tx, dto.onDay);
      const account = (await lockAccounts(tx, [accountId], { live: true })).get(
        accountId,
      )!;
      const amount = money(dto.amount);
      if (amount.isNeg()) await this.holds(tx, account, amount.neg());
      const m = await this.insertMovement(tx, {
        id,
        accountId,
        kind: 'adjustment',
        amount,
        onDay: dto.onDay,
        reasonCode,
      });
      await this.audit.record(tx, {
        action: 'cash_adjustment.recorded',
        targetId: id,
        metadata: {
          accountId,
          amount: show(amount),
          reasonCode,
          onDay: dto.onDay,
        },
      });
      return (await this.movementViews(tx, [m]))[0];
    });
  }

  // --------------------------------------------------------------------------
  // Payouts (ADR 0089)
  // --------------------------------------------------------------------------

  /**
   * The account a vendor's payout is paid from, locked: what it pays (net
   * above zero) leaves a live account of its method's kind (a cash box for
   * cash, a bank account for a transfer or a cheque) on a day the register
   * still takes, and a cash box never goes below zero. Nothing paid, no
   * account. Taken after the payables' rows and lines, before the counters,
   * as a hand-in takes its cash box before its number.
   */
  async payoutAccount(
    tx: TenantTxClient,
    p: {
      cashAccountId?: string;
      method: string;
      net: Prisma.Decimal;
      paidOn: LocalDate;
    },
  ): Promise<string | null> {
    if (!p.net.gt(ZERO)) {
      if (p.cashAccountId)
        throw invalid([
          { field: 'cashAccountId', code: FieldErrorCode.FIELD_NOT_ALLOWED },
        ]);
      return null;
    }
    if (!p.cashAccountId)
      throw invalid([
        { field: 'cashAccountId', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    const today = await this.common.today(tx);
    const min = addDays(today, -MOVEMENT_DAYS_BACK);
    if (p.paidOn < min)
      throw invalid([
        {
          field: 'paidOn',
          code: FieldErrorCode.DAY_OUT_OF_RANGE,
          params: { min, max: today },
        },
      ]);
    const account = (
      await lockAccounts(tx, [p.cashAccountId], {
        live: true,
        kind: p.method === 'cash' ? 'cash' : 'bank',
      })
    ).get(p.cashAccountId)!;
    await this.holds(tx, account, p.net);
    return account.id;
  }

  /** A payout's movement: its net, out, on the account `payoutAccount` locked. */
  async payoutMovement(
    tx: TenantTxClient,
    p: {
      payoutId: string;
      accountId: string;
      net: Prisma.Decimal;
      paidOn: LocalDate;
    },
  ): Promise<void> {
    await this.insertMovement(tx, {
      accountId: p.accountId,
      kind: 'payout',
      amount: p.net.neg(),
      onDay: p.paidOn,
      payoutId: p.payoutId,
    });
  }

  /** A tax payment's movement: its amount, out, on the account `payoutAccount` locked. */
  async taxPaymentMovement(
    tx: TenantTxClient,
    p: {
      taxPaymentId: string;
      accountId: string;
      amount: Prisma.Decimal;
      paidOn: LocalDate;
    },
  ): Promise<void> {
    await this.insertMovement(tx, {
      accountId: p.accountId,
      kind: 'tax_payment',
      amount: p.amount.neg(),
      onDay: p.paidOn,
      taxPaymentId: p.taxPaymentId,
    });
  }

  /**
   * Writes a movement on an account the caller locked. Shared with
   * custody, the cheques and the statements.
   */
  async insertMovement(
    tx: TenantTxClient,
    m: NewMovement & { id?: string },
  ): Promise<FinanceCashMovement> {
    // A payout is bounded by its invoice's limit, a tax paid by its
    // declaration's or quarter's, not the register's.
    if (
      m.kind !== 'payout' &&
      m.kind !== 'tax_payment' &&
      m.amount.abs().gt(MAX_SIGNED)
    )
      throw invalid([{ field: 'amount', code: FieldErrorCode.INVALID_VALUE }]);
    return tx.financeCashMovement.create({
      data: {
        id: m.id ?? newId(),
        tenantId: this.ctx.txTenantId,
        accountId: m.accountId,
        kind: m.kind,
        amount: m.amount,
        onDay: asDate(m.onDay),
        handinId: m.handinId ?? null,
        transferId: m.transferId ?? null,
        chequeId: m.chequeId ?? null,
        matchId: m.matchId ?? null,
        reversesId: m.reversesId ?? null,
        reasonCode: m.reasonCode ?? null,
        payoutId: m.payoutId ?? null,
        taxPaymentId: m.taxPaymentId ?? null,
        recordedById: this.ctx.accountId,
      },
    });
  }

  /** A cash box holds `amount` (its lock held); a bank account may go below zero. */
  async holds(
    tx: TenantTxClient,
    account: FinanceCashAccount,
    amount: Prisma.Decimal,
  ): Promise<void> {
    if (account.kind !== 'cash') return;
    const balance = (await balancesOf(tx, [account.id])).get(account.id)!;
    if (balance.lt(amount))
      throw appError.conflict(
        ErrorCode.CASH_ACCOUNT_INSUFFICIENT,
        'A cash box never goes below zero',
        { params: { balance: show(balance) } },
      );
  }

  async movementViews(
    tx: TenantTxClient,
    rows: readonly FinanceCashMovement[],
  ): Promise<CashMovementView[]> {
    const ref = await this.common.refs(
      tx,
      rows.map((r) => r.recordedById),
    );
    return rows.map((m) => ({
      id: m.id,
      accountId: m.accountId,
      kind: m.kind,
      amount: show(m.amount),
      onDay: fromDate(m.onDay),
      handinId: m.handinId,
      transferId: m.transferId,
      chequeId: m.chequeId,
      matchId: m.matchId,
      reversesId: m.reversesId,
      reasonCode: m.reasonCode,
      payoutId: m.payoutId,
      taxPaymentId: m.taxPaymentId,
      recordedBy: ref(m.recordedById),
      createdAt: m.createdAt,
    }));
  }

  private async dayInRange(
    tx: TenantTxClient,
    onDay: LocalDate,
  ): Promise<void> {
    const today = await this.common.today(tx);
    const min = addDays(today, -MOVEMENT_DAYS_BACK);
    if (onDay > today || onDay < min)
      throw invalid([
        {
          field: 'onDay',
          code: FieldErrorCode.INVALID_VALUE,
          params: { min, max: today },
        },
      ]);
  }

  private async transferView(
    tx: TenantTxClient,
    id: string,
  ): Promise<CashTransferView> {
    const legs = await tx.financeCashMovement.findMany({
      where: { transferId: id },
      orderBy: { amount: 'asc' },
    });
    return { id, legs: await this.movementViews(tx, legs) };
  }

  private async getIn(
    tx: TenantTxClient,
    id: string,
  ): Promise<CashAccountView> {
    const row = await tx.financeCashAccount.findUnique({ where: { id } });
    if (!row) throw accountNotFound();
    return (await this.views(tx, [row]))[0];
  }

  private async views(
    tx: TenantTxClient,
    rows: readonly FinanceCashAccount[],
  ): Promise<CashAccountView[]> {
    const ids = rows.map((r) => r.id);
    const balances = await balancesOf(tx, ids);
    const unmatched = ids.length
      ? await tx.$queryRaw<{ account_id: string; n: number }[]>`
          SELECT l.account_id, count(*)::int AS n FROM finance_statement_lines l
           WHERE l.account_id = ANY(${ids}::uuid[])
             AND NOT EXISTS (SELECT 1 FROM finance_statement_matches m
                              WHERE m.tenant_id = l.tenant_id AND m.line_id = l.id
                                AND m.undone_at IS NULL)
           GROUP BY l.account_id`
      : [];
    const pending = ids.length
      ? await tx.financeCheque.groupBy({
          by: ['depositedToAccountId'],
          where: { depositedToAccountId: { in: ids }, status: 'deposited' },
          _count: { _all: true },
        })
      : [];
    return rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      bankName: a.bankName,
      numberLast4: a.numberLast4,
      openedOn: fromDate(a.openedOn),
      balance: show(balances.get(a.id)!),
      unmatchedLines: unmatched.find((u) => u.account_id === a.id)?.n ?? 0,
      pendingCheques:
        pending.find((p) => p.depositedToAccountId === a.id)?._count._all ?? 0,
      retiredAt: a.retiredAt,
      createdAt: a.createdAt,
    }));
  }
}
