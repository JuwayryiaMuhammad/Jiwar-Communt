import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceBudget,
  type FinanceBudgetLine,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { asDate, dbNow, fromDate, localToday } from '../db-clock';
import { money, ZERO } from '../money';
import {
  BUDGET_CATEGORIES,
  fiscalWindow,
  fiscalYearOf,
  type BudgetCategory,
  type BudgetStatus,
} from './budget-rules';
import { BudgetView } from './views/budgets.views';

export const BUDGET_RESOURCE = 'finance_budget';
const PAGE = keysetCursor('createdAt', 'desc');

/** A line with what it allows and what was spent of it. */
export interface LineFigures {
  line: FinanceBudgetLine;
  increases: Prisma.Decimal;
  allowance: Prisma.Decimal;
  spent: Prisma.Decimal;
  remaining: Prisma.Decimal;
}

export interface BudgetTotals {
  budgeted: Prisma.Decimal;
  increases: Prisma.Decimal;
  allowance: Prisma.Decimal;
  spent: Prisma.Decimal;
  remaining: Prisma.Decimal;
}

export interface BudgetRecord {
  budget: FinanceBudget;
  lines: LineFigures[];
  totals: BudgetTotals;
}

export const budgetNotFound = () =>
  appError.notFound(ErrorCode.BUDGET_NOT_FOUND, 'Budget not found');

export const budgetLineNotFound = () =>
  appError.notFound(ErrorCode.BUDGET_LINE_NOT_FOUND, 'Budget line not found');

const notDraft = (status: string) =>
  appError.conflict(ErrorCode.BUDGET_NOT_DRAFT, 'The budget is not a draft', {
    params: { status },
  });

const order = (c: string) =>
  (BUDGET_CATEGORIES as readonly string[]).indexOf(c);

/**
 * The compound's annual budget (ADR 0055). The accountant drafts one per
 * fiscal year and writes its lines, one per category; it is submitted as
 * an annual_budget request (governance's raise, through the handler this
 * domain registers) and is active once the board approves it. A line's
 * allowance is its amount and its approved increases; what is spent is its
 * live expenses.
 *
 * Locks: the caller's account, then the budget's row (for update to
 * change it; shared to spend from it), then a line's row, then a counter.
 */
@Injectable()
export class BudgetsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: FinanceAccess,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(BUDGET_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        BudgetView.from(
          await this.load(
            tx,
            await tx.financeBudget.findUniqueOrThrow({ where: { id } }),
          ),
        ),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // The fiscal year's month
  // --------------------------------------------------------------------------

  async startMonth(): Promise<number> {
    return this.tenantTx.withTenantTx(
      async (tx) =>
        (
          await tx.financeSettings.findUniqueOrThrow({
            where: { tenantId: this.ctx.txTenantId },
          })
        ).fiscalYearStartMonth,
    );
  }

  /** Changed until a budget was submitted (FISCAL_YEAR_LOCKED). */
  setStartMonth(month: number): Promise<number> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await tx.financeSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.tenantId },
      });
      if (before.fiscalYearStartMonth === month) return month;
      // Any budget, a draft too: its days were taken from the month, and
      // two budgets' years must never straddle.
      if (await tx.financeBudget.count())
        throw appError.conflict(
          ErrorCode.FISCAL_YEAR_LOCKED,
          'A budget exists: the fiscal year stays',
        );
      await tx.financeSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: { fiscalYearStartMonth: month },
      });
      await this.audit.record(tx, {
        action: 'budget.settings_changed',
        targetId: this.ctx.tenantId,
        changes: diffChanges(
          { fiscalYearStartMonth: before.fiscalYearStartMonth },
          { fiscalYearStartMonth: month },
          'budget.settings_changed',
        ),
      });
      return month;
    });
  }

  // --------------------------------------------------------------------------
  // Drafts
  // --------------------------------------------------------------------------

  /**
   * A draft for a fiscal year (the one under way, the one before or the
   * next), optionally with another budget's lines. Refused when the year
   * has an active budget, or one drafted or submitted already.
   */
  draft(input: {
    fiscalYear: number;
    copyFromId?: string;
  }): Promise<BudgetRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // The year's drafting, one at a time: the partial uniques back it.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`finance-budget:${this.ctx.txTenantId}`}), ${input.fiscalYear}::int)`;
      const [s] = await tx.$queryRaw<{ m: number }[]>`
        SELECT fiscal_year_start_month AS m FROM finance_settings
         WHERE tenant_id = ${this.ctx.txTenantId}::uuid FOR SHARE`;
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const current = fiscalYearOf(await localToday(tx, timezone), s.m);
      if (input.fiscalYear < current - 1 || input.fiscalYear > current + 1)
        throw invalid([
          {
            field: 'fiscalYear',
            code: FieldErrorCode.INVALID_NUMBER,
            params: { min: current - 1, max: current + 1 },
          },
        ]);
      const same = await tx.financeBudget.findMany({
        where: {
          fiscalYear: input.fiscalYear,
          status: { in: ['draft', 'submitted', 'active'] },
        },
      });
      const active = same.find((b) => b.status === 'active');
      if (active)
        throw appError.conflict(
          ErrorCode.BUDGET_YEAR_ACTIVE,
          'The fiscal year has an active budget',
          { params: { budgetId: active.id } },
        );
      if (same.length)
        throw appError.conflict(
          ErrorCode.BUDGET_IN_PROGRESS,
          'The fiscal year has a budget in the making',
          { params: { budgetId: same[0].id } },
        );
      const from = input.copyFromId
        ? await tx.financeBudget.findUnique({ where: { id: input.copyFromId } })
        : null;
      if (input.copyFromId && !from) throw budgetNotFound();
      const id = newId();
      await this.idempotency.claim(tx, { type: BUDGET_RESOURCE, id });
      const window = fiscalWindow(input.fiscalYear, s.m);
      const now = await dbNow(tx);
      const budget = await tx.financeBudget.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          fiscalYear: input.fiscalYear,
          startsOn: asDate(window.startsOn),
          endsOn: asDate(window.endsOn),
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      if (from) {
        const lines = await tx.financeBudgetLine.findMany({
          where: { budgetId: from.id },
        });
        if (lines.length)
          await tx.financeBudgetLine.createMany({
            data: lines.map((l) => ({
              id: newId(),
              tenantId: this.ctx.txTenantId,
              budgetId: id,
              category: l.category,
              amount: l.amount,
              note: l.note,
            })),
          });
      }
      await this.audit.record(tx, {
        action: 'budget.drafted',
        targetId: id,
        metadata: {
          fiscalYear: input.fiscalYear,
          startsOn: window.startsOn,
          endsOn: window.endsOn,
          copiedFrom: from?.id ?? null,
        },
      });
      return this.load(tx, budget);
    });
  }

  /** A draft's lines, replaced as a whole. */
  replaceLines(
    id: string,
    lines: { category: BudgetCategory; amount: string; note?: string | null }[],
  ): Promise<BudgetRecord> {
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      if (seen.has(l.category))
        throw invalid([
          {
            field: `lines[${i}].category`,
            code: FieldErrorCode.DUPLICATE_VALUE,
          },
        ]);
      seen.add(l.category);
    });
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const budget = await this.lock(tx, id, 'update');
      if (budget.status !== 'draft') throw notDraft(budget.status);
      const before = await tx.financeBudgetLine.findMany({
        where: { budgetId: id },
      });
      await tx.financeBudgetLine.deleteMany({ where: { budgetId: id } });
      if (lines.length)
        await tx.financeBudgetLine.createMany({
          data: lines.map((l) => ({
            id: newId(),
            tenantId: this.ctx.txTenantId,
            budgetId: id,
            category: l.category,
            amount: l.amount,
            note: l.note ?? null,
          })),
        });
      const total = (ls: { amount: Prisma.Decimal.Value }[]) =>
        ls.reduce((t, l) => t.add(money(l.amount)), ZERO).toFixed(2);
      await this.audit.record(tx, {
        action: 'budget.lines_replaced',
        targetId: id,
        changes: diffChanges(
          {
            lines: before.length,
            total: total(before),
            notes: before.map((l) => l.note ?? ''),
          },
          {
            lines: lines.length,
            total: total(lines),
            notes: lines.map((l) => l.note ?? ''),
          },
          'budget.lines_replaced',
        ),
      });
      return this.load(tx, budget);
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  list(q: {
    fiscalYear?: number;
    status?: BudgetStatus;
    cursor?: string;
    limit?: number;
  }): Promise<Page<BudgetRecord>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.financeBudget.findMany({
        where: {
          AND: [
            q.fiscalYear ? { fiscalYear: q.fiscalYear } : {},
            q.status ? { status: q.status } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: BudgetRecord[] = [];
      for (const b of page.items) items.push(await this.load(tx, b));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<BudgetRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const budget = await tx.financeBudget.findUnique({ where: { id } });
      if (!budget) throw budgetNotFound();
      return this.load(tx, budget);
    });
  }

  // --------------------------------------------------------------------------
  // For the handlers and the expenses, in their transactions
  // --------------------------------------------------------------------------

  /** The budget's row locked, read again after the lock; null when unknown. */
  async lockOrNull(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<FinanceBudget | null> {
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM finance_budgets WHERE id = ${id}::uuid FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM finance_budgets WHERE id = ${id}::uuid FOR SHARE`;
    if (!rows.length) return null;
    return tx.financeBudget.findUniqueOrThrow({ where: { id } });
  }

  async lock(
    tx: TenantTxClient,
    id: string,
    mode: 'share' | 'update',
  ): Promise<FinanceBudget> {
    const budget = await this.lockOrNull(tx, id, mode);
    if (!budget) throw budgetNotFound();
    return budget;
  }

  /** A line's row, for update (after its budget's), read again. */
  async lockLine(tx: TenantTxClient, id: string): Promise<FinanceBudgetLine> {
    await tx.$queryRaw`
      SELECT id FROM finance_budget_lines WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.financeBudgetLine.findUniqueOrThrow({ where: { id } });
  }

  /** One line's figures now (under its lock, for a decision). */
  async figuresOf(
    tx: TenantTxClient,
    line: FinanceBudgetLine,
  ): Promise<LineFigures> {
    const [row] = await tx.$queryRaw<
      { increases: Prisma.Decimal | null; spent: Prisma.Decimal | null }[]
    >`
      SELECT (SELECT sum(a.amount) FROM finance_budget_adjustments a
               WHERE a.line_id = ${line.id}::uuid) AS increases,
             (SELECT sum(e.amount) FROM finance_expenses e
               WHERE e.budget_line_id = ${line.id}::uuid AND e.voided_at IS NULL) AS spent`;
    return figures(line, row.increases, row.spent);
  }

  /** A budget with every line's figures. */
  async load(tx: TenantTxClient, budget: FinanceBudget): Promise<BudgetRecord> {
    const lines = await tx.financeBudgetLine.findMany({
      where: { budgetId: budget.id },
    });
    const sums = await tx.$queryRaw<
      {
        line_id: string;
        increases: Prisma.Decimal | null;
        spent: Prisma.Decimal | null;
      }[]
    >`
      SELECT l.id AS line_id,
             (SELECT sum(a.amount) FROM finance_budget_adjustments a WHERE a.line_id = l.id) AS increases,
             (SELECT sum(e.amount) FROM finance_expenses e
               WHERE e.budget_line_id = l.id AND e.voided_at IS NULL) AS spent
        FROM finance_budget_lines l
       WHERE l.budget_id = ${budget.id}::uuid`;
    const by = new Map(sums.map((s) => [s.line_id, s]));
    const out = lines
      .sort((a, b) => order(a.category) - order(b.category))
      .map((l) =>
        figures(
          l,
          by.get(l.id)?.increases ?? null,
          by.get(l.id)?.spent ?? null,
        ),
      );
    const add = (pick: (f: LineFigures) => Prisma.Decimal) =>
      out.reduce((t, f) => t.add(pick(f)), ZERO);
    return {
      budget,
      lines: out,
      totals: {
        budgeted: add((f) => money(f.line.amount)),
        increases: add((f) => f.increases),
        allowance: add((f) => f.allowance),
        spent: add((f) => f.spent),
        remaining: add((f) => f.remaining),
      },
    };
  }

  /** The days a budget's expenses fall in, and today, for a check. */
  async window(
    tx: TenantTxClient,
    budget: FinanceBudget,
  ): Promise<{ from: string; to: string; today: string }> {
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    return {
      from: fromDate(budget.startsOn),
      to: fromDate(budget.endsOn),
      today: await localToday(tx, timezone),
    };
  }
}

function figures(
  line: FinanceBudgetLine,
  increases: Prisma.Decimal.Value | null,
  spent: Prisma.Decimal.Value | null,
): LineFigures {
  const inc = money(increases ?? 0);
  const sp = money(spent ?? 0);
  const allowance = money(line.amount).add(inc);
  return {
    line,
    increases: inc,
    allowance,
    spent: sp,
    remaining: allowance.sub(sp),
  };
}
