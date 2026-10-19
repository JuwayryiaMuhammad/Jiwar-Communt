import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { AppException, ErrorCode } from '../../core/common/errors';
import { ReportsService } from '../reports/reports.service';
import type { UnitReportQueryDto } from '../reports/dto/reports.dto';
import { BudgetReportService } from './budget-report.service';

/**
 * Finance's part of the board's overview (ADR 0055), from the existing
 * reports and nothing new: what is owed today (aging and outstanding,
 * their totals only: never a unit), what was collected over the period,
 * and the active budget's totals against what was spent.
 */
@Injectable()
export class FinanceOverview implements OnModuleInit {
  constructor(
    private readonly matters: BoardMatters,
    private readonly reports: ReportsService,
    private readonly budgets: BudgetReportService,
  ) {}

  onModuleInit(): void {
    this.matters.registerOverview('finance', async ({ from, to }) => {
      const byBuilding = { groupBy: 'building' } as UnitReportQueryDto;
      const aging = await this.reports.aging(byBuilding);
      const outstanding = await this.reports.outstanding(byBuilding);
      const collections = await this.reports.collections({
        from,
        to,
        groupBy: 'month',
      });
      const budget = await this.budgets.report({}).catch((e: unknown) => {
        if (e instanceof AppException && e.code === ErrorCode.BUDGET_NOT_FOUND)
          return null;
        throw e;
      });
      return {
        asOf: aging.asOf,
        currency: 'EGP',
        aging: aging.totals,
        outstanding: outstanding.totals,
        collections: {
          gross: collections.gross,
          reversed: collections.reversed,
          net: collections.net,
        },
        budget: budget
          ? {
              budgetId: budget.budgetId,
              fiscalYear: budget.fiscalYear,
              totals: budget.totals,
            }
          : null,
      };
    });
  }
}
