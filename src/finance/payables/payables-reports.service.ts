import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  ExportLimit,
  exportTooLarge,
  toCsv,
  type CsvColumn,
} from '../../core/common/csv';
import { FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { addDays } from '../../core/common/slots/day-slots';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { fromDate, localToday } from '../db-clock';
import { money, show, ZERO } from '../money';
import type { CsvDownload } from '../reports/reports.service';
import { PAYABLE_LIMITS } from './payable-rules';

export interface ScheduleRow {
  /** An approved invoice to pay, or what a commitment keeps for that day. */
  kind: 'invoice' | 'commitment';
  id: string;
  day: string;
  amount: string;
  /** VI- for an invoice; null for a commitment. */
  reference: string | null;
  source: 'contract' | 'purchase_request';
  contractId: string | null;
  purchaseRequestId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  budgetLineId: string;
  category: string;
}

export interface PaymentSchedule {
  from: string;
  to: string;
  asOf: string;
  rows: ScheduleRow[];
  totals: { invoices: string; commitments: string; all: string };
  /** Approved invoices due before today and not paid. */
  overdue: { count: number; amount: string };
}

const ENTRY_COLUMNS: readonly CsvColumn[] = [
  { header: 'date', kind: 'text' },
  { header: 'kind', kind: 'text' },
  { header: 'reference', kind: 'text' },
  { header: 'id', kind: 'text' },
  { header: 'vendor_id', kind: 'text' },
  { header: 'vendor', kind: 'text' },
  { header: 'category', kind: 'text' },
  { header: 'budget_line_id', kind: 'text' },
  { header: 'amount', kind: 'number' },
  { header: 'tax', kind: 'number' },
  { header: 'retention', kind: 'number' },
  { header: 'advance_set_off', kind: 'number' },
  { header: 'net', kind: 'number' },
  { header: 'detail', kind: 'text' },
];

/**
 * Payables' reads (ADR 0089): the payment schedule — what is approved to
 * pay and what commitments keep, by day, by default for next month (next
 * month's commitments) — and the entries export a future ledger takes:
 * every money event of a period once, from its own row, in one CSV.
 */
@Injectable()
export class PayablesReportsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly settings: TenantSettingsService,
    private readonly exportLimit: ExportLimit,
  ) {}

  schedule(q: { from?: string; to?: string }): Promise<PaymentSchedule> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = await localToday(tx, timezone);
      const next = nextMonth(today);
      const from = q.from ?? next.from;
      const to = q.to ?? (q.from ? addDays(from, 30) : next.to);
      period(from, to);
      const rows = await tx.$queryRaw<
        {
          kind: 'invoice' | 'commitment';
          id: string;
          day: Date;
          amount: Prisma.Decimal;
          number: number | null;
          contract_id: string | null;
          purchase_request_id: string | null;
          vendor_id: string | null;
          vendor_name: string | null;
          line_id: string;
          category: string;
        }[]
      >`
        SELECT 'invoice' AS kind, i.id, i.due_on AS day, i.total AS amount, i.number,
               i.contract_id, i.purchase_request_id, i.vendor_id, v.name AS vendor_name,
               i.budget_line_id AS line_id, l.category
          FROM finance_vendor_invoices i
          JOIN finance_budget_lines l ON l.id = i.budget_line_id
          LEFT JOIN vendors v ON v.id = i.vendor_id
         WHERE i.status = 'approved' AND i.due_on BETWEEN ${from}::date AND ${to}::date
        UNION ALL
        SELECT 'commitment', c.id, c.due_on, c.amount - COALESCE(r.released, 0), NULL,
               c.contract_id, c.purchase_request_id, c.vendor_id, v.name,
               c.line_id, l.category
          FROM finance_commitments c
          JOIN finance_budget_lines l ON l.id = c.line_id
          LEFT JOIN vendors v ON v.id = c.vendor_id
          LEFT JOIN (SELECT commitment_id, sum(amount) AS released
                       FROM finance_commitment_releases GROUP BY commitment_id) r
            ON r.commitment_id = c.id
         WHERE c.closed_at IS NULL AND c.due_on BETWEEN ${from}::date AND ${to}::date
         ORDER BY day, kind, id
         LIMIT 1000`;
      const [late] = await tx.$queryRaw<
        { n: bigint; amount: Prisma.Decimal | null }[]
      >`
        SELECT count(*) AS n, sum(total) AS amount FROM finance_vendor_invoices
         WHERE status = 'approved' AND due_on < ${today}::date`;
      const sum = (k: string) =>
        rows
          .filter((r) => r.kind === k)
          .reduce((a, r) => a.add(r.amount), ZERO);
      const invoices = sum('invoice');
      const commitments = sum('commitment');
      return {
        from,
        to,
        asOf: today,
        rows: rows.map((r) => ({
          kind: r.kind,
          id: r.id,
          day: fromDate(r.day),
          amount: show(r.amount),
          reference:
            r.number === null
              ? null
              : `VI-${String(r.number).padStart(6, '0')}`,
          source: r.purchase_request_id ? 'purchase_request' : 'contract',
          contractId: r.contract_id,
          purchaseRequestId: r.purchase_request_id,
          vendorId: r.vendor_id,
          vendorName: r.vendor_name,
          budgetLineId: r.line_id,
          category: r.category,
        })),
        totals: {
          invoices: show(invoices),
          commitments: show(commitments),
          all: show(invoices.add(commitments)),
        },
        overdue: {
          count: Number(late.n),
          amount: show(money(late.amount ?? 0)),
        },
      };
    });
  }

  /**
   * Every money event of the period once, by the compound's day: an
   * expense and its void, a vendor's invoice approved and one called off
   * after its approval, a payout (gross, what was held and set off, net),
   * a commitment and each release, an applied transfer, an approved
   * increase. Signed: what gives budget back is negative. At most
   * ExportLimit.maxRows (EXPORT_TOO_LARGE).
   */
  entriesCsv(q: { from: string; to: string }): Promise<CsvDownload> {
    period(q.from, q.to);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const day = (col: string) =>
        Prisma.sql`(${Prisma.raw(col)} AT TIME ZONE ${timezone})::date`;
      const max = this.exportLimit.maxRows;
      // Constant prefixes and columns only: never a caller's words.
      const ref = (prefix: 'EX' | 'VI' | 'VP', col: string) =>
        Prisma.raw(`'${prefix}-' || lpad(${col}::text, 6, '0')`);
      const rows = await tx.$queryRaw<
        {
          day: Date;
          kind: string;
          reference: string | null;
          id: string;
          vendor_id: string | null;
          vendor: string | null;
          category: string | null;
          line_id: string | null;
          amount: Prisma.Decimal;
          tax: Prisma.Decimal | null;
          retention: Prisma.Decimal | null;
          set_off: Prisma.Decimal | null;
          net: Prisma.Decimal | null;
          detail: string | null;
        }[]
      >`
        SELECT * FROM (
          SELECT e.spent_on AS day, 'expense' AS kind, ${ref('EX', 'e.number')} AS reference, e.id,
                 e.vendor_id, e.vendor, l.category, e.budget_line_id AS line_id, e.amount,
                 NULL::numeric AS tax, NULL::numeric AS retention, NULL::numeric AS set_off,
                 NULL::numeric AS net,
                 CASE WHEN e.vendor_invoice_id IS NULL THEN NULL ELSE 'payout' END AS detail
            FROM finance_expenses e JOIN finance_budget_lines l ON l.id = e.budget_line_id
          UNION ALL
          SELECT ${day('e.voided_at')}, 'expense_void', ${ref('EX', 'e.number')}, e.id,
                 e.vendor_id, e.vendor, l.category, e.budget_line_id, -e.amount,
                 NULL, NULL, NULL, NULL, e.void_reason_code
            FROM finance_expenses e JOIN finance_budget_lines l ON l.id = e.budget_line_id
           WHERE e.voided_at IS NOT NULL
          UNION ALL
          SELECT ${day('i.decided_at')}, 'invoice_approved', ${ref('VI', 'i.number')}, i.id,
                 i.vendor_id, v.name, l.category, i.budget_line_id, i.total,
                 i.tax, NULL, NULL, NULL, i.vendor_number
            FROM finance_vendor_invoices i
            JOIN finance_budget_lines l ON l.id = i.budget_line_id
            LEFT JOIN vendors v ON v.id = i.vendor_id
           WHERE i.decided_at IS NOT NULL AND i.reject_reason IS NULL
          UNION ALL
          SELECT ${day('i.cancelled_at')}, 'invoice_cancelled', ${ref('VI', 'i.number')}, i.id,
                 i.vendor_id, v.name, l.category, i.budget_line_id, -i.total,
                 -i.tax, NULL, NULL, NULL, i.cancel_reason
            FROM finance_vendor_invoices i
            JOIN finance_budget_lines l ON l.id = i.budget_line_id
            LEFT JOIN vendors v ON v.id = i.vendor_id
           WHERE i.cancelled_at IS NOT NULL AND i.decided_at IS NOT NULL
          UNION ALL
          SELECT p.paid_on, 'payout', ${ref('VP', 'p.number')}, p.id,
                 p.vendor_id, v.name, NULL, NULL, p.gross,
                 NULL, p.retention_held, p.advance_set_off, p.net, p.kind || ':' || p.method
            FROM finance_vendor_payouts p LEFT JOIN vendors v ON v.id = p.vendor_id
          UNION ALL
          SELECT ${day('c.created_at')}, 'commitment', NULL, c.id,
                 c.vendor_id, v.name, l.category, c.line_id, c.amount,
                 NULL, NULL, NULL, NULL, c.source
            FROM finance_commitments c
            JOIN finance_budget_lines l ON l.id = c.line_id
            LEFT JOIN vendors v ON v.id = c.vendor_id
          UNION ALL
          SELECT ${day('r.created_at')}, 'commitment_release', NULL, r.id,
                 c.vendor_id, v.name, l.category, c.line_id, -r.amount,
                 NULL, NULL, NULL, NULL, r.reason
            FROM finance_commitment_releases r
            JOIN finance_commitments c ON c.id = r.commitment_id
            JOIN finance_budget_lines l ON l.id = c.line_id
            LEFT JOIN vendors v ON v.id = c.vendor_id
          UNION ALL
          SELECT ${day('t.decided_at')}, 'budget_transfer', NULL, t.id,
                 NULL, NULL, lt.category, t.to_line_id, t.amount,
                 NULL, NULL, NULL, NULL, 'from:' || lf.category
            FROM finance_budget_transfers t
            JOIN finance_budget_lines lf ON lf.id = t.from_line_id
            JOIN finance_budget_lines lt ON lt.id = t.to_line_id
           WHERE t.status = 'applied'
          UNION ALL
          SELECT ${day('a.created_at')}, 'budget_increase', NULL, a.id,
                 NULL, NULL, l.category, a.line_id, a.amount,
                 NULL, NULL, NULL, NULL, NULL
            FROM finance_budget_adjustments a JOIN finance_budget_lines l ON l.id = a.line_id
        ) x
        WHERE x.day BETWEEN ${q.from}::date AND ${q.to}::date
        ORDER BY x.day, x.kind, x.id
        LIMIT ${max + 1}`;
      if (rows.length > max) throw exportTooLarge(max);
      const n = (v: Prisma.Decimal | null) => (v === null ? null : show(v));
      return {
        name: `finance-entries-${q.from}-${q.to}.csv`,
        body: toCsv(
          ENTRY_COLUMNS,
          rows.map((r) => [
            fromDate(r.day),
            r.kind,
            r.reference,
            r.id,
            r.vendor_id,
            r.vendor,
            r.category,
            r.line_id,
            show(r.amount),
            n(r.tax),
            n(r.retention),
            n(r.set_off),
            n(r.net),
            r.detail,
          ]),
        ),
      };
    });
  }
}

/** A period of at most PAYABLE_LIMITS.periodDays, in order. */
function period(from: string, to: string): void {
  if (to < from)
    throw invalid([{ field: 'to', code: FieldErrorCode.ENDS_BEFORE_START }]);
  if (addDays(from, PAYABLE_LIMITS.periodDays - 1) < to)
    throw invalid([
      {
        field: 'to',
        code: FieldErrorCode.DAY_OUT_OF_RANGE,
        params: { max: addDays(from, PAYABLE_LIMITS.periodDays - 1) },
      },
    ]);
}

/** The local month after `today`'s: its first and last days. */
function nextMonth(today: string): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const from = `${ny}-${String(nm).padStart(2, '0')}-01`;
  const ay = nm === 12 ? ny + 1 : ny;
  const am = nm === 12 ? 1 : nm + 1;
  return { from, to: addDays(`${ay}-${String(am).padStart(2, '0')}-01`, -1) };
}
