import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  REPORT_MAX_ROWS,
  StaffReports,
} from '../../core/reports/report-registry';
import { CREDITED_SQL, PAID_SQL } from '../invoices/balances';

/** Fewer units than this in a building are folded into "other buildings". */
export const BUILDING_MIN_UNITS = 3;

/**
 * Finance's report (ADR 0086), for whoever reads the finance reports
 * (`finance.reports`): per building (ADR 0072), what the invoices due on
 * the period's days asked after credit notes, what of it is paid, what is
 * still owed, and the share collected — from the same fragments as every
 * finance read (ADR 0046). Never a unit or a payer: a building with fewer
 * than three invoiced units is folded into one row with the other small
 * ones (null building), so no row is one household's dues.
 */
@Injectable()
export class FinanceReports implements OnModuleInit {
  constructor(private readonly reports: StaffReports) {}

  onModuleInit(): void {
    this.reports.register({
      key: 'collections_by_building',
      permission: 'finance.reports',
      title: { en: 'Collections by building', ar: 'التحصيل حسب المبنى' },
      groupBy: ['building'],
      columns: () => ({
        columns: [
          { key: 'building', en: 'Building', ar: 'المبنى', kind: 'text' },
          {
            key: 'units',
            en: 'Invoiced units',
            ar: 'الوحدات المفوترة',
            kind: 'number',
            sum: true,
          },
          {
            key: 'invoices',
            en: 'Invoices',
            ar: 'الفواتير',
            kind: 'number',
            sum: true,
          },
          { key: 'due', en: 'Due', ar: 'المستحق', kind: 'money', sum: true },
          { key: 'paid', en: 'Paid', ar: 'المحصل', kind: 'money', sum: true },
          {
            key: 'owed',
            en: 'Still owed',
            ar: 'المتبقي',
            kind: 'money',
            sum: true,
          },
          {
            key: 'rate',
            en: 'Collected %',
            ar: 'نسبة التحصيل %',
            kind: 'number',
          },
        ],
        dimensions: 1,
      }),
      read: async (tx, q) => {
        const rows = await tx.$queryRaw<Record<string, string | null>[]>`
          WITH inv AS (
            SELECT u.building AS b, i.unit_id,
                   i.total - ${CREDITED_SQL} AS due,
                   ${PAID_SQL} AS paid
              FROM invoices i
              JOIN units u ON u.id = i.unit_id
             WHERE i.due_on BETWEEN ${q.period.from}::date AND ${q.period.to}::date
          ), sized AS (
            SELECT b, count(DISTINCT unit_id) AS n FROM inv GROUP BY b
          ), g AS (
            SELECT CASE WHEN s.n >= ${BUILDING_MIN_UNITS}::int THEN inv.b END AS building,
                   count(DISTINCT inv.unit_id) AS units, count(*) AS invoices,
                   SUM(inv.due) AS due, SUM(LEAST(inv.paid, inv.due)) AS paid,
                   SUM(GREATEST(inv.due - inv.paid, 0)) AS owed
              FROM inv JOIN sized s ON s.b IS NOT DISTINCT FROM inv.b
             GROUP BY 1
          )
          SELECT building, units::text, invoices::text, due::text, paid::text, owed::text,
                 CASE WHEN due > 0 THEN round(paid * 100 / due, 1)::text END AS rate
            FROM g
           ORDER BY building IS NULL, building
           LIMIT ${REPORT_MAX_ROWS + 1}`;
        return {
          rows: rows.map((r) =>
            [
              'building',
              'units',
              'invoices',
              'due',
              'paid',
              'owed',
              'rate',
            ].map((k) => r[k] ?? null),
          ),
        };
      },
    });
  }
}
