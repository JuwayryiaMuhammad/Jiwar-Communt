import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import {
  BoardMatters,
  type BoardNoticeDraft,
} from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow, fromDate } from '../db-clock';
import { money, show } from '../money';
import { CATEGORY_LABELS, type BudgetCategory } from './budget-rules';
import {
  BudgetsService,
  budgetLineNotFound,
  budgetNotFound,
  type BudgetRecord,
} from './budgets.service';

/**
 * What the board's decisions do in finance (ADR 0055), registered with
 * core's BoardMatters: governance calls them in its transaction, after its
 * own locks (the request, the motion), as the acting account.
 *
 * - annual_budget (a draft budget): submitted at the raise, its total the
 *   cost; approved, it is active and published to the owners as the
 *   board's announcement; rejected or withdrawn, it is final.
 * - budget_increase (a line of the active budget): approved, the line
 *   gains the cost.
 * - major_contract: approved, an authorization expenses above the
 *   manager's limit spend down.
 *
 * At a decision nothing throws for the budget's state: what cannot be
 * applied is not implemented, and the manager follows it up.
 */
@Injectable()
export class BudgetMatters implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly budgets: BudgetsService,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.matters.registerApproval('annual_budget', {
      subject: 'budget',
      raise: (tx, ev) => this.submit(tx, ev.requestId, ev.subjectId!),
      describe: async (tx, id) => {
        const b = id
          ? await tx.financeBudget.findUnique({ where: { id } })
          : null;
        return b ? described(await this.budgets.load(tx, b)) : null;
      },
      decided: (tx, ev) =>
        this.decideBudget(tx, ev.requestId, ev.subjectId!, ev.approved, ev.now),
      withdrawn: (tx, ev) =>
        this.withdrawBudget(tx, ev.requestId, ev.subjectId!, ev.now),
    });
    this.matters.registerApproval('budget_increase', {
      subject: 'budget_line',
      raise: async (tx, ev) => {
        await this.activeLine(tx, ev.subjectId!, 'raise');
        return { cost: ev.cost };
      },
      describe: async (tx, id) => {
        const line = id
          ? await tx.financeBudgetLine.findUnique({ where: { id } })
          : null;
        if (!line) return null;
        const budget = await tx.financeBudget.findUniqueOrThrow({
          where: { id: line.budgetId },
        });
        const f = await this.budgets.figuresOf(tx, line);
        return {
          budgetId: budget.id,
          fiscalYear: budget.fiscalYear,
          category: line.category,
          budgeted: show(line.amount),
          increases: show(f.increases),
          allowance: show(f.allowance),
          spent: show(f.spent),
          remaining: show(f.remaining),
        };
      },
      decided: async (tx, ev) => {
        if (!ev.approved || !ev.cost) return { implemented: false };
        const line = await this.activeLine(tx, ev.subjectId!, 'decide');
        if (!line) return { implemented: false };
        await tx.financeBudgetAdjustment.create({
          data: {
            id: newId(),
            tenantId: this.ctx.txTenantId,
            lineId: line.id,
            approvalRequestId: ev.requestId,
            amount: ev.cost,
            createdAt: ev.now,
          },
        });
        await this.audit.record(tx, {
          action: 'budget_line.increased',
          targetId: line.id,
          metadata: {
            budgetId: line.budgetId,
            requestId: ev.requestId,
            amount: ev.cost,
          },
        });
        return { implemented: true };
      },
      withdrawn: () => Promise.resolve(),
    });
    this.matters.registerApproval('major_contract', {
      subject: null,
      raise: (_tx, ev) => Promise.resolve({ cost: ev.cost }),
      describe: () => Promise.resolve(null),
      decided: async (tx, ev) => {
        if (!ev.approved || !ev.cost) return { implemented: false };
        const id = newId();
        await tx.financeExpenseAuthorization.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            approvalRequestId: ev.requestId,
            amount: ev.cost,
            createdAt: ev.now,
          },
        });
        await this.audit.record(tx, {
          action: 'expense_authorization.granted',
          targetId: id,
          metadata: { requestId: ev.requestId, amount: ev.cost },
        });
        // The contract is carried out by the expenses: the manager marks it.
        return { implemented: false };
      },
      withdrawn: () => Promise.resolve(),
    });
  }

  /** At the raise: a draft with lines, now submitted; its total the cost. */
  private async submit(
    tx: TenantTxClient,
    requestId: string,
    budgetId: string,
  ): Promise<{ cost: string }> {
    const budget = await this.budgets.lock(tx, budgetId, 'update');
    if (budget.status !== 'draft')
      throw appError.conflict(
        ErrorCode.BUDGET_NOT_DRAFT,
        'Only a draft is put to the board',
        { params: { status: budget.status } },
      );
    const active = await tx.financeBudget.findFirst({
      where: { fiscalYear: budget.fiscalYear, status: 'active' },
    });
    if (active)
      throw appError.conflict(
        ErrorCode.BUDGET_YEAR_ACTIVE,
        'The fiscal year has an active budget',
        { params: { budgetId: active.id } },
      );
    const record = await this.budgets.load(tx, budget);
    if (!record.lines.length)
      throw appError.conflict(ErrorCode.BUDGET_EMPTY, 'The budget has no line');
    const now = await dbNow(tx);
    await tx.financeBudget.update({
      where: { id: budgetId },
      data: {
        status: 'submitted',
        submittedAt: now,
        approvalRequestId: requestId,
      },
    });
    const cost = show(record.totals.budgeted);
    await this.audit.record(tx, {
      action: 'budget.submitted',
      targetId: budgetId,
      metadata: { requestId, total: cost },
    });
    return { cost };
  }

  private async decideBudget(
    tx: TenantTxClient,
    requestId: string,
    budgetId: string,
    approved: boolean,
    now: Date,
  ): Promise<{ implemented: boolean; notice?: BoardNoticeDraft }> {
    const budget = await this.budgets.lockOrNull(tx, budgetId, 'update');
    if (
      !budget ||
      budget.status !== 'submitted' ||
      budget.approvalRequestId !== requestId
    )
      return { implemented: false };
    if (
      approved &&
      (await tx.financeBudget.findFirst({
        where: { fiscalYear: budget.fiscalYear, status: 'active' },
      }))
    )
      return { implemented: false };
    const status = approved ? 'active' : 'rejected';
    await tx.financeBudget.update({
      where: { id: budgetId },
      data: { status, decidedAt: now },
    });
    await this.audit.record(tx, {
      action: 'budget.decided',
      targetId: budgetId,
      metadata: { requestId, status },
    });
    if (!approved) return { implemented: false };
    return {
      implemented: true,
      notice: announcement(await this.budgets.load(tx, budget)),
    };
  }

  private async withdrawBudget(
    tx: TenantTxClient,
    requestId: string,
    budgetId: string,
    now: Date,
  ): Promise<void> {
    const budget = await this.budgets.lockOrNull(tx, budgetId, 'update');
    if (
      !budget ||
      budget.status !== 'submitted' ||
      budget.approvalRequestId !== requestId
    )
      return;
    await tx.financeBudget.update({
      where: { id: budgetId },
      data: { status: 'withdrawn', decidedAt: now },
    });
    await this.audit.record(tx, {
      action: 'budget.withdrawn',
      targetId: budgetId,
      metadata: { requestId },
    });
  }

  /**
   * A line of the active budget: its budget shared, the line for update. At
   * the raise an unknown line or a budget not active refuses; at the
   * decision it is null instead.
   */
  private async activeLine(
    tx: TenantTxClient,
    lineId: string,
    when: 'raise' | 'decide',
  ) {
    const seen = await tx.financeBudgetLine.findUnique({
      where: { id: lineId },
    });
    if (!seen) {
      if (when === 'raise') throw budgetLineNotFound();
      return null;
    }
    const budget = await this.budgets.lockOrNull(tx, seen.budgetId, 'share');
    if (!budget) {
      if (when === 'raise') throw budgetNotFound();
      return null;
    }
    const line = await this.budgets.lockLine(tx, lineId);
    if (budget.status !== 'active') {
      if (when === 'raise')
        throw appError.conflict(
          ErrorCode.BUDGET_NOT_ACTIVE,
          'The line’s budget is not active',
          { params: { status: budget.status } },
        );
      return null;
    }
    return line;
  }
}

/** A budget as the board reads it with the package. */
function described(r: BudgetRecord) {
  return {
    budgetId: r.budget.id,
    fiscalYear: r.budget.fiscalYear,
    startsOn: fromDate(r.budget.startsOn),
    endsOn: fromDate(r.budget.endsOn),
    status: r.budget.status,
    total: show(r.totals.budgeted),
    lines: r.lines.map((f) => ({
      category: f.line.category,
      amount: show(f.line.amount),
      note: f.line.note,
    })),
  };
}

/** The board's announcement of an approved budget, in English and Arabic. */
function announcement(r: BudgetRecord): BoardNoticeDraft {
  const b = r.budget;
  const from = fromDate(b.startsOn);
  const to = fromDate(b.endsOn);
  const total = show(r.totals.budgeted);
  const lines = (lang: 'en' | 'ar') =>
    r.lines
      .map(
        (f) =>
          `- ${CATEGORY_LABELS[f.line.category as BudgetCategory][lang]}: ${show(money(f.line.amount))} ${lang === 'en' ? 'EGP' : 'جنيه'}`,
      )
      .join('\n');
  return {
    titleEn: `The budget for ${b.fiscalYear} is approved`,
    bodyEn: `The board approved the compound's budget for ${from} to ${to}: ${total} EGP in all.\n\n${lines('en')}`,
    titleAr: `اعتماد موازنة ${b.fiscalYear}`,
    bodyAr: `اعتمد المجلس موازنة المجمع للفترة من ${from} إلى ${to}: ${total} جنيه إجمالًا.\n\n${lines('ar')}`,
  };
}
