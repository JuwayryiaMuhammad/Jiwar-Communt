import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  REPORT_MAX_ROWS,
  StaffReports,
  type ReportColumn,
} from '../../core/reports/report-registry';
import {
  StaffInbox,
  afterCursor,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { formatNumber } from '../counters';
import { fromDate } from '../db-clock';
import { show } from '../money';
import { GlLedgerService } from './gl-ledger.service';

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
const CODE = text('code', 'Code', 'الرمز');
const ACCOUNT = text('account', 'Account', 'الحساب');
const TYPE = text('type', 'Type', 'النوع');
const DEBIT = sum('debit', 'Debit', 'مدين');
const CREDIT = sum('credit', 'Credit', 'دائن');
const AMOUNT = sum('amount', 'Amount', 'المبلغ');

/**
 * The general ledger's places in core's registries (ADR 0092):
 *
 * - **the staff inbox** (ADR 0073): `gl_manual_entry`, a manual entry
 *   waiting for its second person, to `finance.ledger_write`, 72 hours;
 *   decided on its own page, never in bulk (its maker never approves it);
 * - **the reports platform** (ADR 0086), each read with `finance.ledger`,
 *   on screen, as a PDF, a workbook or CSV, compared and scheduled:
 *   `gl_trial_balance` (each account's balance at the period's end, by
 *   account or type), `gl_income_statement` (the period's revenue and
 *   expenses, by account, type or month), `gl_balance_sheet` (assets,
 *   liabilities and equity at the period's end, with the surplus) and
 *   `gl_general_ledger` (every line of the period by account). Accounts,
 *   types, months and entries only: never a unit, a person or a manual
 *   entry's words.
 */
@Injectable()
export class GlSections implements OnModuleInit {
  constructor(
    private readonly inbox: StaffInbox,
    private readonly reports: StaffReports,
    private readonly ledger: GlLedgerService,
  ) {}

  onModuleInit(): void {
    this.inbox.register({
      type: 'gl_manual_entry',
      permission: 'finance.ledger_write',
      dueHours: 72,
      page: async (tx, q) => {
        const rows = await tx.glManualEntry.findMany({
          where: {
            AND: [
              { status: 'pending' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, number: true, status: true, createdAt: true },
        });
        return rows.map((r) => ({
          type: 'gl_manual_entry' as const,
          id: r.id,
          number: formatNumber('journal_entry', r.number),
          kind: null,
          status: r.status,
          unitId: null,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, requestedBefore) =>
        tx.glManualEntry.count({
          where: {
            AND: [
              { status: 'pending' },
              ...waitingSince('createdAt', requestedBefore),
            ],
          },
        }),
    });

    this.reports.register({
      key: 'gl_trial_balance',
      permission: 'finance.ledger',
      title: { en: 'Trial balance', ar: 'ميزان المراجعة' },
      groupBy: ['account', 'type'],
      columns: (g) =>
        g === 'type'
          ? { columns: [TYPE, DEBIT, CREDIT], dimensions: 1 }
          : { columns: [CODE, ACCOUNT, DEBIT, CREDIT], dimensions: 1 },
      read: async (tx, q) => {
        const t = await this.ledger.trialBalanceIn(tx, q.period.to);
        if (q.groupBy === 'type') {
          const types = [...new Set(t.rows.map((r) => r.type))];
          return {
            rows: types.map((type) => {
              const of = t.rows.filter((r) => r.type === type);
              return [
                type,
                show(
                  of.reduce((s, r) => s.add(r.debit), new Prisma.Decimal(0)),
                ),
                show(
                  of.reduce((s, r) => s.add(r.credit), new Prisma.Decimal(0)),
                ),
              ];
            }),
          };
        }
        return {
          rows: t.rows
            .slice(0, REPORT_MAX_ROWS + 1)
            .map((r) => [r.code, r.nameEn, show(r.debit), show(r.credit)]),
        };
      },
    });

    this.reports.register({
      key: 'gl_income_statement',
      permission: 'finance.ledger',
      title: { en: 'Income statement', ar: 'قائمة الدخل' },
      groupBy: ['account', 'type', 'month'],
      columns: (g) =>
        g === 'month'
          ? {
              columns: [
                text('month', 'Month', 'الشهر'),
                sum('revenue', 'Revenue', 'الإيرادات'),
                sum('expenses', 'Expenses', 'المصروفات'),
                sum('surplus', 'Surplus', 'الفائض'),
              ],
              dimensions: 1,
            }
          : g === 'type'
            ? { columns: [TYPE, AMOUNT], dimensions: 1 }
            : { columns: [CODE, ACCOUNT, TYPE, AMOUNT], dimensions: 1 },
      read: async (tx, q) => {
        if (q.groupBy === 'month') {
          const rows = await tx.$queryRaw<
            { m: string; revenue: string; expenses: string; surplus: string }[]
          >`
            SELECT to_char(l.posted_on, 'YYYY-MM') AS m,
                   COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a.type = 'revenue'), 0.00)::text AS revenue,
                   COALESCE(SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0.00)::text AS expenses,
                   (COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a.type = 'revenue'), 0)
                    - COALESCE(SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0))::numeric(14,2)::text AS surplus
              FROM gl_lines l
              JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
             WHERE a.type IN ('revenue', 'expense')
               AND l.posted_on BETWEEN ${q.period.from}::date AND ${q.period.to}::date
             GROUP BY 1 ORDER BY 1
             LIMIT ${REPORT_MAX_ROWS + 1}`;
          return {
            rows: rows.map((r) => [r.m, r.revenue, r.expenses, r.surplus]),
          };
        }
        const s = await this.ledger.incomeStatementIn(tx, q.period);
        const rows = [...s.revenue, ...s.expenses];
        if (q.groupBy === 'type')
          return {
            rows: [
              ['revenue', show(s.totalRevenue)],
              ['expense', show(s.totalExpenses)],
            ],
          };
        return {
          rows: rows
            .slice(0, REPORT_MAX_ROWS + 1)
            .map((r) => [r.code, r.nameEn, r.type, show(r.amount)]),
        };
      },
    });

    this.reports.register({
      key: 'gl_balance_sheet',
      permission: 'finance.ledger',
      title: { en: 'Balance sheet', ar: 'الميزانية العمومية' },
      groupBy: ['account', 'type'],
      columns: (g) =>
        g === 'type'
          ? { columns: [TYPE, AMOUNT], dimensions: 1 }
          : { columns: [CODE, ACCOUNT, TYPE, AMOUNT], dimensions: 1 },
      read: async (tx, q) => {
        const b = await this.ledger.balanceSheetIn(tx, q.period.to);
        if (q.groupBy === 'type')
          return {
            rows: [
              ['asset', show(b.totalAssets)],
              ['liability', show(b.totalLiabilities)],
              ['equity', show(b.totalEquity)],
            ],
          };
        const rows = [...b.assets, ...b.liabilities, ...b.equity].map((r) => [
          r.code,
          r.nameEn,
          r.type,
          show(r.amount),
        ]);
        rows.push(['surplus', 'Surplus to date', 'equity', show(b.surplus)]);
        return { rows: rows.slice(0, REPORT_MAX_ROWS + 1) };
      },
    });

    this.reports.register({
      key: 'gl_general_ledger',
      permission: 'finance.ledger',
      title: { en: 'General ledger', ar: 'دفتر الأستاذ العام' },
      groupBy: ['line'],
      columns: () => ({
        columns: [
          CODE,
          text('day', 'Day', 'اليوم'),
          text('entry', 'Entry', 'القيد'),
          text('line', 'Line', 'السطر'),
          ACCOUNT,
          text('source', 'Source', 'المصدر'),
          text('reference', 'Reference', 'المرجع'),
          DEBIT,
          CREDIT,
        ],
        dimensions: 4,
      }),
      read: async (tx, q) => {
        const rows = await tx.$queryRaw<
          {
            code: string;
            day: Date;
            seq: string;
            line_no: number;
            name_en: string;
            source: string;
            reference: string | null;
            debit: Prisma.Decimal;
            credit: Prisma.Decimal;
          }[]
        >`
          SELECT a.code, l.posted_on AS day, l.entry_seq::text AS seq, l.line_no, a.name_en,
                 e.source, e.reference, l.debit, l.credit
            FROM gl_lines l
            JOIN gl_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            JOIN gl_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
           WHERE l.posted_on BETWEEN ${q.period.from}::date AND ${q.period.to}::date
           ORDER BY a.code, l.posted_on, l.entry_seq, l.line_no
           LIMIT ${REPORT_MAX_ROWS + 1}`;
        return {
          rows: rows.map((r) => [
            r.code,
            fromDate(r.day),
            r.seq,
            String(r.line_no),
            r.name_en,
            r.source,
            r.reference,
            show(r.debit),
            show(r.credit),
          ]),
        };
      },
    });
  }
}
