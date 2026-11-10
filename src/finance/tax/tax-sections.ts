import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  REPORT_MAX_ROWS,
  StaffReports,
  type ReportColumn,
} from '../../core/reports/report-registry';
import { show } from '../money';

const text = (key: string, en: string, ar: string): ReportColumn => ({
  key,
  en,
  ar,
  kind: 'text',
});
const sum = (key: string, en: string, ar: string): ReportColumn => ({
  key,
  en,
  ar,
  kind: 'money',
  sum: true,
});
const count = (key: string, en: string, ar: string): ReportColumn => ({
  key,
  en,
  ar,
  kind: 'number',
  sum: true,
});

const VAT_FIGURES = [
  sum('taxable_sales', 'Taxable sales', 'المبيعات الخاضعة'),
  sum('output_vat', 'Output VAT', 'ضريبة المبيعات'),
  sum('taxable_purchases', 'Taxable purchases', 'المشتريات الخاضعة'),
  sum('input_vat', 'Input VAT', 'ضريبة المشتريات'),
  sum('net_vat', 'Net VAT', 'صافي الضريبة'),
];

type Money = Prisma.Decimal;

/**
 * Taxes on the reports platform (ADR 0086, 0093), each read with
 * `finance.ledger`, on screen, as a PDF, a workbook or CSV, compared and
 * scheduled:
 *
 * - `tax_vat`: the VAT declaration's figures from the ledger by its
 *   entries' days — taxable sales, output VAT, taxable purchases, input
 *   VAT and the net — by month or by the kind of entry;
 * - `tax_withholding`: the tax withheld from vendors' payouts by their
 *   certificates — by vendor (a company, ADR 0077: its name and tax
 *   number, as the quarterly return lists them), category or month.
 */
@Injectable()
export class TaxSections implements OnModuleInit {
  constructor(private readonly reports: StaffReports) {}

  onModuleInit(): void {
    this.reports.register({
      key: 'tax_vat',
      permission: 'finance.ledger',
      title: { en: 'VAT declaration', ar: 'إقرار ضريبة القيمة المضافة' },
      groupBy: ['month', 'source'],
      columns: (g) => ({
        columns: [
          g === 'source'
            ? text('source', 'Source', 'المصدر')
            : text('month', 'Month', 'الشهر'),
          ...VAT_FIGURES,
        ],
        dimensions: 1,
      }),
      read: async (tx, q) => {
        const key =
          q.groupBy === 'source'
            ? Prisma.sql`e.source`
            : Prisma.sql`to_char(e.posted_on, 'YYYY-MM')`;
        const rows = await tx.$queryRaw<
          {
            k: string;
            sales: Money | null;
            output: Money | null;
            purchases: Money | null;
            input: Money | null;
          }[]
        >`
          SELECT ${key} AS k,
                 SUM(l.credit - l.debit) FILTER (WHERE a.type = 'revenue') AS sales,
                 SUM(l.credit - l.debit) FILTER (WHERE a.system_key = 'vat_payable') AS output,
                 SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense') AS purchases,
                 SUM(l.debit - l.credit) FILTER (WHERE a.system_key = 'vat_receivable') AS input
            FROM gl_entries e
            JOIN gl_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
            JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
           WHERE e.source IN ('invoice', 'credit_note', 'vendor_invoice', 'vendor_invoice_cancel')
             AND e.posted_on BETWEEN ${q.period.from}::date AND ${q.period.to}::date
             AND EXISTS (SELECT 1 FROM gl_lines x
                           JOIN gl_accounts k ON k.tenant_id = x.tenant_id AND k.id = x.account_id
                          WHERE x.tenant_id = e.tenant_id AND x.entry_id = e.id
                            AND k.system_key IN ('vat_payable', 'vat_receivable'))
           GROUP BY 1 ORDER BY 1
           LIMIT ${REPORT_MAX_ROWS + 1}`;
        return {
          rows: rows.map((r) => {
            const output = new Prisma.Decimal(r.output ?? 0);
            const input = new Prisma.Decimal(r.input ?? 0);
            return [
              r.k,
              show(r.sales ?? 0),
              show(output),
              show(r.purchases ?? 0),
              show(input),
              show(output.sub(input)),
            ];
          }),
        };
      },
    });

    this.reports.register({
      key: 'tax_withholding',
      permission: 'finance.ledger',
      title: { en: 'Withholding tax', ar: 'ضريبة الخصم من المنبع' },
      groupBy: ['vendor', 'category', 'month'],
      columns: (g) => {
        const figures = [
          count('certificates', 'Certificates', 'الشهادات'),
          sum('base', 'Amount subject', 'المبلغ الخاضع'),
          sum('withheld', 'Tax withheld', 'الضريبة المخصومة'),
        ];
        if (g === 'vendor')
          return {
            columns: [
              text('vendor', 'Vendor', 'المورد'),
              text('tax_number', 'Tax number', 'الرقم الضريبي'),
              ...figures,
            ],
            dimensions: 2,
          };
        return {
          columns: [
            g === 'category'
              ? text('category', 'Category', 'الفئة')
              : text('month', 'Month', 'الشهر'),
            ...figures,
          ],
          dimensions: 1,
        };
      },
      read: async (tx, q) => {
        const rows =
          q.groupBy === 'vendor'
            ? await tx.$queryRaw<
                {
                  k: string;
                  t: string | null;
                  n: number;
                  base: Money;
                  amount: Money;
                }[]
              >`
                SELECT COALESCE(v.legal_name, v.name) AS k, v.tax_number AS t,
                       count(*)::int AS n, SUM(c.base) AS base, SUM(c.amount) AS amount
                  FROM finance_withholding_certificates c
                  JOIN vendors v ON v.tenant_id = c.tenant_id AND v.id = c.vendor_id
                 WHERE c.paid_on BETWEEN ${q.period.from}::date AND ${q.period.to}::date
                 GROUP BY v.id, 1, 2 ORDER BY 1, 2
                 LIMIT ${REPORT_MAX_ROWS + 1}`
            : await tx.$queryRaw<
                { k: string; t: null; n: number; base: Money; amount: Money }[]
              >`
                SELECT ${
                  q.groupBy === 'category'
                    ? Prisma.sql`c.category`
                    : Prisma.sql`to_char(c.paid_on, 'YYYY-MM')`
                } AS k, NULL AS t,
                       count(*)::int AS n, SUM(c.base) AS base, SUM(c.amount) AS amount
                  FROM finance_withholding_certificates c
                 WHERE c.paid_on BETWEEN ${q.period.from}::date AND ${q.period.to}::date
                 GROUP BY 1 ORDER BY 1
                 LIMIT ${REPORT_MAX_ROWS + 1}`;
        return {
          rows: rows.map((r) =>
            q.groupBy === 'vendor'
              ? [r.k, r.t, String(r.n), show(r.base), show(r.amount)]
              : [r.k, String(r.n), show(r.base), show(r.amount)],
          ),
        };
      },
    });
  }
}
