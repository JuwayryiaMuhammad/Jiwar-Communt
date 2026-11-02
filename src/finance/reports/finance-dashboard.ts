import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StaffDashboard } from '../../core/staff-dashboard/staff-dashboard';
import { CREDITED_SQL, PAID_SQL } from '../invoices/balances';
import { CURRENCY, money, show } from '../money';

type Money = Prisma.Decimal;

/**
 * Finance's section of the operations dashboard (ADR 0079), for whoever
 * reads the finance reports (`finance.reports`), from the same rows and
 * rules as the reports (ADR 0048): what was collected today and this
 * month by the compound's days, net of reversals (the collections
 * report's); what the invoices due this month so far ask after credit
 * notes, and the share of it paid; and what is owed past its due day (the
 * aging's late buckets). Totals only: never a unit or a payer.
 */
@Injectable()
export class FinanceDashboardSection implements OnModuleInit {
  constructor(private readonly dashboard: StaffDashboard) {}

  onModuleInit(): void {
    this.dashboard.register({
      section: 'finance',
      permissions: ['finance.reports'],
      figures: async (tx, day) => {
        const [c] = await tx.$queryRaw<{ today: Money; month: Money }[]>`
          WITH events AS (
            SELECT p.paid_on AS d, p.amount AS amount
              FROM finance_payments p
             WHERE p.kind = 'payment'
               AND p.paid_on BETWEEN ${day.monthDate}::date AND ${day.date}::date
            UNION ALL
            SELECT (r.created_at AT TIME ZONE ${day.timeZone})::date, -p.amount
              FROM finance_payments r
              JOIN finance_payments p ON p.tenant_id = r.tenant_id AND p.id = r.reverses_id
             WHERE r.kind = 'reversal'
               AND r.created_at >= ${day.monthStart} AND r.created_at < ${day.end}
          )
          SELECT COALESCE(SUM(amount) FILTER (WHERE d = ${day.date}::date), 0) AS today,
                 COALESCE(SUM(amount), 0) AS month
            FROM events`;
        const [i] = await tx.$queryRaw<
          { due: Money; owed: Money; late: bigint; late_owed: Money }[]
        >`
          WITH invoiced AS (
            SELECT i.due_on, i.total - ${CREDITED_SQL} AS due,
                   GREATEST(i.total - ${CREDITED_SQL} - ${PAID_SQL}, 0) AS owed
              FROM invoices i
             WHERE i.due_on <= ${day.date}::date
          )
          SELECT COALESCE(SUM(due) FILTER (WHERE due_on >= ${day.monthDate}::date), 0) AS due,
                 COALESCE(SUM(owed) FILTER (WHERE due_on >= ${day.monthDate}::date), 0) AS owed,
                 count(*) FILTER (WHERE due_on < ${day.date}::date AND owed > 0) AS late,
                 COALESCE(SUM(owed) FILTER (WHERE due_on < ${day.date}::date), 0) AS late_owed
            FROM invoiced`;
        const due = money(i.due);
        return {
          currency: CURRENCY,
          collectedToday: show(c.today),
          collectedMonth: show(c.month),
          dueMonth: show(due),
          collectionRate: due.gt(0)
            ? Math.round(due.sub(money(i.owed)).div(due).toNumber() * 1000) /
              1000
            : null,
          overdueInvoices: Number(i.late),
          overdueAmount: show(i.late_owed),
        };
      },
    });
  }
}
