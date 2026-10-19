import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceExpense,
  type FinanceExpenseAuthorization,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { requireReasonCodeOnly, REASON_CODES } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { FinanceAccess } from '../access';
import { takeNumbers } from '../counters';
import { asDate, dbNow } from '../db-clock';
import { money, show } from '../money';
import { BudgetsService, budgetLineNotFound } from './budgets.service';
import { ExpenseView } from './views/budgets.views';

export const EXPENSE_RESOURCE = 'finance_expense';
const PAGE = keysetCursor('recordedAt', 'desc');

export interface NewExpense {
  budgetLineId: string;
  vendor: string;
  amount: string;
  spentOn: string;
  invoiceFileId: string;
  reference?: string;
  authorizationId?: string;
}

export interface ExpenseRecord {
  expense: FinanceExpense;
  budgetId: string;
  fiscalYear: number;
  category: string;
  invoiceUrl: string | null;
  recordedByMe: boolean;
}

export interface AuthorizationRecord {
  authorization: FinanceExpenseAuthorization;
  spent: Prisma.Decimal;
  remaining: Prisma.Decimal;
}

const expenseNotFound = () =>
  appError.notFound(ErrorCode.EXPENSE_NOT_FOUND, 'Expense not found');

/**
 * What the compound spends (ADR 0055), against a line of the active
 * budget. Decided under the line's lock (its budget shared, then the line
 * for update), so two expenses at once never spend the same remainder; the
 * manager's limit is major_contract's threshold (governance's settings
 * row, shared, through core's BoardMatters), and an expense above it names
 * an approved major contract (its authorization, for update after the
 * line), spent down by the expenses that name it.
 *
 * Locks: the caller's account → the budget (shared) → the line (update) →
 * the threshold's row (shared) → the authorization (update) → the counter.
 */
@Injectable()
export class ExpensesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: FinanceAccess,
    private readonly budgets: BudgetsService,
    private readonly matters: BoardMatters,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(EXPENSE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        ExpenseView.from(
          await this.load(
            tx,
            await tx.financeExpense.findUniqueOrThrow({ where: { id } }),
          ),
        ),
      ),
    );
  }

  record(input: NewExpense): Promise<ExpenseRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.financeBudgetLine.findUnique({
        where: { id: input.budgetLineId },
      });
      if (!seen) throw budgetLineNotFound();
      const budget = await this.budgets.lock(tx, seen.budgetId, 'share');
      const line = await this.budgets.lockLine(tx, seen.id);
      if (budget.status !== 'active')
        throw appError.conflict(
          ErrorCode.BUDGET_NOT_ACTIVE,
          'The line’s budget is not active',
          { params: { status: budget.status } },
        );
      const { from, to, today } = await this.budgets.window(tx, budget);
      const last = to < today ? to : today;
      if (input.spentOn < from || input.spentOn > last)
        throw invalid([
          {
            field: 'spentOn',
            code: FieldErrorCode.DAY_OUT_OF_RANGE,
            params: { min: from, max: last },
          },
        ]);
      const amount = money(input.amount);
      const { remaining } = await this.budgets.figuresOf(tx, line);
      if (amount.gt(remaining))
        throw appError.conflict(
          ErrorCode.EXPENSE_OVER_BUDGET,
          'More than the line has left',
          { params: { remaining: show(remaining) } },
        );
      const limit = await this.matters.threshold(tx, 'major_contract');
      let authorizationId: string | null = null;
      if (input.authorizationId) {
        const auth = await this.lockAuthorization(tx, input.authorizationId);
        if (amount.gt(auth.remaining))
          throw appError.conflict(
            ErrorCode.EXPENSE_AUTHORIZATION_EXCEEDED,
            'More than the approved contract has left',
            { params: { remaining: show(auth.remaining) } },
          );
        authorizationId = auth.authorization.id;
      } else if (limit !== null && amount.gt(money(limit)))
        throw appError.conflict(
          ErrorCode.EXPENSE_NEEDS_APPROVAL,
          'Above the manager’s limit: the board approves it as a major contract',
          { params: { limit } },
        );
      const id = newId();
      await this.idempotency.claim(tx, { type: EXPENSE_RESOURCE, id });
      const file = await this.files.claim(
        tx,
        input.invoiceFileId,
        'expense_invoice',
      );
      if (!file)
        throw invalid([
          { field: 'invoiceFileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      await this.files.attach(tx, file);
      const number = await takeNumbers(tx, this.ctx.txTenantId, 'expense');
      const now = await dbNow(tx);
      const expense = await tx.financeExpense.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          budgetLineId: line.id,
          authorizationId,
          vendor: input.vendor,
          amount: input.amount,
          spentOn: asDate(input.spentOn),
          invoiceFileId: file.id,
          reference: input.reference ?? null,
          recordedById: this.ctx.accountId,
          recordedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'expense.recorded',
        targetId: id,
        changes: diffChanges(
          null,
          {
            number,
            lineId: line.id,
            authorizationId,
            amount: show(amount),
            spentOn: input.spentOn,
            vendor: input.vendor,
            reference: input.reference ?? null,
          },
          'expense.recorded',
        ),
      });
      return this.load(tx, expense);
    });
  }

  /** Voided once, with a code: the line has it again. */
  void(id: string, reasonCode: string | undefined): Promise<ExpenseRecord> {
    const reason = requireReasonCodeOnly(reasonCode, REASON_CODES.expenseVoid);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const seen = await tx.financeExpense.findUnique({ where: { id } });
      if (!seen) throw expenseNotFound();
      const line = await tx.financeBudgetLine.findUniqueOrThrow({
        where: { id: seen.budgetLineId },
      });
      await this.budgets.lock(tx, line.budgetId, 'share');
      await this.budgets.lockLine(tx, line.id);
      await tx.$queryRaw`
        SELECT id FROM finance_expenses WHERE id = ${id}::uuid FOR UPDATE`;
      const expense = await tx.financeExpense.findUniqueOrThrow({
        where: { id },
      });
      if (expense.voidedAt)
        throw appError.conflict(
          ErrorCode.EXPENSE_ALREADY_VOIDED,
          'The expense is voided already',
        );
      const voided = await tx.financeExpense.update({
        where: { id },
        data: {
          voidedAt: await dbNow(tx),
          voidedById: this.ctx.accountId,
          voidReasonCode: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'expense.voided',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      return this.load(tx, voided);
    });
  }

  list(q: {
    budgetId?: string;
    budgetLineId?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ExpenseRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const lineIds = q.budgetId
        ? (
            await tx.financeBudgetLine.findMany({
              where: { budgetId: q.budgetId },
              select: { id: true },
            })
          ).map((l) => l.id)
        : undefined;
      const rows = await tx.financeExpense.findMany({
        where: {
          AND: [
            lineIds ? { budgetLineId: { in: lineIds } } : {},
            q.budgetLineId ? { budgetLineId: q.budgetLineId } : {},
            q.from ? { spentOn: { gte: asDate(q.from) } } : {},
            q.to ? { spentOn: { lte: asDate(q.to) } } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: ExpenseRecord[] = [];
      for (const e of page.items) items.push(await this.load(tx, e));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<ExpenseRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const expense = await tx.financeExpense.findUnique({ where: { id } });
      if (!expense) throw expenseNotFound();
      return this.load(tx, expense);
    });
  }

  /** The board's approved major contracts, with what is left of each. */
  authorizations(): Promise<AuthorizationRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeExpenseAuthorization.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      const out: AuthorizationRecord[] = [];
      for (const a of rows) out.push(await this.withSpent(tx, a));
      return out;
    });
  }

  // --------------------------------------------------------------------------

  private async lockAuthorization(
    tx: TenantTxClient,
    id: string,
  ): Promise<AuthorizationRecord> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM finance_expense_authorizations WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length)
      throw appError.notFound(
        ErrorCode.EXPENSE_AUTHORIZATION_NOT_FOUND,
        'Approved contract not found',
      );
    return this.withSpent(
      tx,
      await tx.financeExpenseAuthorization.findUniqueOrThrow({ where: { id } }),
    );
  }

  private async withSpent(
    tx: TenantTxClient,
    authorization: FinanceExpenseAuthorization,
  ): Promise<AuthorizationRecord> {
    const sum = await tx.financeExpense.aggregate({
      where: { authorizationId: authorization.id, voidedAt: null },
      _sum: { amount: true },
    });
    const spent = money(sum._sum.amount ?? 0);
    return {
      authorization,
      spent,
      remaining: money(authorization.amount).sub(spent),
    };
  }

  private async load(
    tx: TenantTxClient,
    expense: FinanceExpense,
  ): Promise<ExpenseRecord> {
    const line = await tx.financeBudgetLine.findUniqueOrThrow({
      where: { id: expense.budgetLineId },
    });
    const budget = await tx.financeBudget.findUniqueOrThrow({
      where: { id: line.budgetId },
    });
    return {
      expense,
      budgetId: budget.id,
      fiscalYear: budget.fiscalYear,
      category: line.category,
      invoiceUrl:
        (await this.files.readUrl(tx, expense.invoiceFileId))?.url ?? null,
      recordedByMe: expense.recordedById === this.ctx.accountId,
    };
  }
}
