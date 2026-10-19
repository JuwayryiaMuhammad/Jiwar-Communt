import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { toCsv, type CsvColumn } from '../../core/common/csv';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { fromDate, localToday } from '../db-clock';
import { money, show } from '../money';
import type { CsvDownload } from '../reports/reports.service';
import { fiscalYearOf, type BudgetCategory } from './budget-rules';
import {
  BudgetsService,
  budgetNotFound,
  type BudgetRecord,
} from './budgets.service';

export interface BudgetVsActualRow {
  category: BudgetCategory;
  budgeted: string;
  increases: string;
  allowance: string;
  actual: string;
  remaining: string;
  /** actual ÷ allowance, a percentage with one decimal. */
  usedPct: string;
}

export interface BudgetVsActual {
  budgetId: string;
  fiscalYear: number;
  startsOn: string;
  endsOn: string;
  status: string;
  /** The compound's day the actuals are read on. */
  asOf: string;
  currency: 'EGP';
  rows: BudgetVsActualRow[];
  totals: Omit<BudgetVsActualRow, 'category'>;
}

const pct = (part: Prisma.Decimal, whole: Prisma.Decimal) =>
  whole.isZero() ? '0.0' : part.mul(100).div(whole).toFixed(1);

const COLUMNS: readonly CsvColumn[] = [
  { header: 'category', kind: 'text' },
  { header: 'budgeted', kind: 'number' },
  { header: 'increases', kind: 'number' },
  { header: 'allowance', kind: 'number' },
  { header: 'actual', kind: 'number' },
  { header: 'remaining', kind: 'number' },
  { header: 'used_pct', kind: 'number' },
];

/**
 * Budget vs actual (ADR 0055): per line of a budget, what was budgeted,
 * the approved increases, the allowance, what was spent (live expenses)
 * and what is left, with the totals; the same figures the budget's own
 * view shows, from one query. Read with `finance.reports`. Without a
 * budget named, the active budget of the fiscal year under way.
 */
@Injectable()
export class BudgetReportService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly budgets: BudgetsService,
    private readonly settings: TenantSettingsService,
  ) {}

  report(q: {
    budgetId?: string;
    fiscalYear?: number;
  }): Promise<BudgetVsActual> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const asOf = await localToday(tx, timezone);
      let budget = q.budgetId
        ? await tx.financeBudget.findUnique({ where: { id: q.budgetId } })
        : null;
      if (!q.budgetId) {
        const { fiscalYearStartMonth } =
          await tx.financeSettings.findUniqueOrThrow({
            where: { tenantId: this.ctx.txTenantId },
          });
        budget = await tx.financeBudget.findFirst({
          where: {
            fiscalYear:
              q.fiscalYear ?? fiscalYearOf(asOf, fiscalYearStartMonth),
            status: 'active',
          },
        });
      }
      if (!budget) throw budgetNotFound();
      return shape(await this.budgets.load(tx, budget), asOf);
    });
  }

  async csv(q: {
    budgetId?: string;
    fiscalYear?: number;
  }): Promise<CsvDownload> {
    const r = await this.report(q);
    const line = (category: string, x: Omit<BudgetVsActualRow, 'category'>) => [
      category,
      x.budgeted,
      x.increases,
      x.allowance,
      x.actual,
      x.remaining,
      x.usedPct,
    ];
    return {
      name: `budget-vs-actual-${r.fiscalYear}.csv`,
      body: toCsv(COLUMNS, [
        ...r.rows.map((row) => line(row.category, row)),
        line('all', r.totals),
      ]),
    };
  }
}

/** Shared with the board's overview: the report's figures from a loaded budget. */
export function shape(r: BudgetRecord, asOf: string): BudgetVsActual {
  return {
    budgetId: r.budget.id,
    fiscalYear: r.budget.fiscalYear,
    startsOn: fromDate(r.budget.startsOn),
    endsOn: fromDate(r.budget.endsOn),
    status: r.budget.status,
    asOf,
    currency: 'EGP',
    rows: r.lines.map((f) => ({
      category: f.line.category as BudgetCategory,
      budgeted: show(f.line.amount),
      increases: show(f.increases),
      allowance: show(f.allowance),
      actual: show(f.spent),
      remaining: show(f.remaining),
      usedPct: pct(f.spent, f.allowance),
    })),
    totals: {
      budgeted: show(r.totals.budgeted),
      increases: show(r.totals.increases),
      allowance: show(r.totals.allowance),
      actual: show(r.totals.spent),
      remaining: show(r.totals.remaining),
      usedPct: pct(r.totals.spent, money(r.totals.allowance)),
    },
  };
}
