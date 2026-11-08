import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  REPORT_MAX_ROWS,
  StaffReports,
} from '../../core/reports/report-registry';
import { StaffDashboard } from '../../core/staff-dashboard/staff-dashboard';
import { CASH_FLOW_PERIODS } from './cash-flow-rules';
import { CashFlowService } from './cash-flow.service';

/** The realised report's groupings, and the column each groups on. */
const DIMENSIONS = {
  month: {
    sql: Prisma.raw(`to_char(m.on_day, 'YYYY-MM')`),
    en: 'Month',
    ar: 'الشهر',
  },
  kind: { sql: Prisma.raw('m.kind'), en: 'Movement', ar: 'نوع الحركة' },
  account: { sql: Prisma.raw('a.name'), en: 'Account', ar: 'الحساب' },
} as const;
type Dimension = keyof typeof DIMENSIONS;

/**
 * Cash flow's places in core's registries (ADR 0091):
 *
 * - **the dashboard's liquidity** (ADR 0079's `liquidityDays`, and the
 *   minimum-cash alerts of "needs you now"), to `finance.cashflow`;
 * - **the realised cash flow report** (`cash_flow`, ADR 0086's platform,
 *   `finance.cashflow`): what moved into and out of the compound's bank
 *   and cash accounts on the period's days, by month, by the movement's
 *   kind or by account. Money between two of the compound's own accounts
 *   (a transfer) and an account's opening balance are not flows: they are
 *   left out. Never a unit, a payer or a vendor.
 */
@Injectable()
export class CashFlowSections implements OnModuleInit {
  constructor(
    private readonly dashboard: StaffDashboard,
    private readonly reports: StaffReports,
    private readonly cashFlow: CashFlowService,
  ) {}

  onModuleInit(): void {
    this.dashboard.registerLiquidity({
      permissions: ['finance.cashflow'],
      days: (tx, day) => this.cashFlow.liquidityIn(tx, day.date),
      alert: async (tx, day) => {
        const f = await this.cashFlow.read(tx, {
          today: day.date,
          timeZone: day.timeZone,
          by: 'week',
          count: CASH_FLOW_PERIODS.week.default,
        });
        if (f.belowMinimumNow)
          return {
            section: 'finance',
            code: 'cash_below_minimum',
            severity: 'critical',
            count: Math.max(f.periodsBelowMinimum, 1),
          };
        if (f.periodsBelowMinimum > 0)
          return {
            section: 'finance',
            code: 'cash_forecast_below_minimum',
            severity: 'warning',
            count: f.periodsBelowMinimum,
          };
        return null;
      },
    });

    this.reports.register({
      key: 'cash_flow',
      permission: 'finance.cashflow',
      title: { en: 'Cash flow (actual)', ar: 'التدفق النقدي الفعلي' },
      groupBy: ['month', 'kind', 'account'],
      columns: (groupBy) => {
        const d = DIMENSIONS[groupBy as Dimension];
        return {
          columns: [
            { key: groupBy, en: d.en, ar: d.ar, kind: 'text' },
            {
              key: 'in',
              en: 'Money in',
              ar: 'الداخل',
              kind: 'money',
              sum: true,
            },
            {
              key: 'out',
              en: 'Money out',
              ar: 'الخارج',
              kind: 'money',
              sum: true,
            },
            { key: 'net', en: 'Net', ar: 'الصافي', kind: 'money', sum: true },
          ],
          dimensions: 1,
        };
      },
      read: async (tx, q) => {
        const d = DIMENSIONS[q.groupBy as Dimension];
        const rows = await tx.$queryRaw<
          { d: string; inn: string; out: string; net: string }[]
        >`
          SELECT ${d.sql} AS d,
                 COALESCE(SUM(m.amount) FILTER (WHERE m.amount > 0), 0.00)::text AS inn,
                 COALESCE(-SUM(m.amount) FILTER (WHERE m.amount < 0), 0.00)::text AS out,
                 SUM(m.amount)::text AS net
            FROM finance_cash_movements m
            JOIN finance_cash_accounts a ON a.id = m.account_id
           WHERE m.kind NOT IN ('opening', 'transfer')
             AND m.on_day BETWEEN ${q.period.from}::date AND ${q.period.to}::date
           GROUP BY 1
           ORDER BY 1
           LIMIT ${REPORT_MAX_ROWS + 1}`;
        return { rows: rows.map((r) => [r.d, r.inn, r.out, r.net]) };
      },
    });
  }
}
