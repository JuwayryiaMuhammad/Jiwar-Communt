import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import type { LocalDate } from '../../core/common/slots/day-slots';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { formatNumber } from '../counters';
import { localToday } from '../db-clock';
import { CREDITED_SQL, PAID_SQL } from '../invoices/balances';
import { money, show, ZERO } from '../money';
import { FREE_SQL } from '../payments/allocation';
import { toCsv, type CsvColumn } from './csv';
import type {
  CollectionsQueryDto,
  DailyCashQueryDto,
  UnitReportQueryDto,
} from './dto/reports.dto';
import { checkPeriod } from './ledger.service';
import type {
  AgingRowView,
  AgingView,
  CashEventView,
  CashierRowView,
  CollectionRowView,
  CollectionsView,
  DailyCashView,
  OutstandingRowView,
  OutstandingView,
} from './views/reports.views';

type Money = Prisma.Decimal;

/** A report's CSV and the name it downloads as. */
export interface CsvDownload {
  name: string;
  body: Buffer;
}

const csv = (
  name: string,
  columns: readonly CsvColumn[],
  rows: readonly (readonly (string | null)[])[],
): CsvDownload => ({ name, body: toCsv(columns, rows) });
const sum = (xs: readonly Money[]) => xs.reduce((a, b) => a.add(b), ZERO);

/**
 * The finance reports (ADR 0048), each computed in a fixed number of
 * aggregate queries from the append-only rows, and each with a CSV twin:
 * aging of what is owed, collections by period and channel, what each unit
 * or building owes, and the office's day per recorder for its closing.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly tenantSettings: TenantSettingsService,
    private readonly community: CommunityFinancePort,
  ) {}

  // --------------------------------------------------------------------------
  // Aging
  // --------------------------------------------------------------------------

  /**
   * What is owed today by how far past its due date: not yet due, 1–30,
   * 31–60, 61–90 and 91 days or more. Per unit or per building.
   */
  aging(q: UnitReportQueryDto): Promise<AgingView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const today = await this.today(tx);
      const rows = await tx.$queryRaw<
        {
          unit_id: string | null;
          unit_code: string | null;
          building: string | null;
          not_due: Money;
          d30: Money;
          d60: Money;
          d90: Money;
          d91: Money;
        }[]
      >`
        WITH owed AS (
          SELECT i.unit_id, ${today}::date - i.due_on AS late,
                 i.total - ${CREDITED_SQL} - ${PAID_SQL} AS owed
            FROM invoices i
        )
        SELECT ${this.groupKey(q)},
               SUM(o.owed) FILTER (WHERE o.late <= 0) AS not_due,
               SUM(o.owed) FILTER (WHERE o.late BETWEEN 1 AND 30) AS d30,
               SUM(o.owed) FILTER (WHERE o.late BETWEEN 31 AND 60) AS d60,
               SUM(o.owed) FILTER (WHERE o.late BETWEEN 61 AND 90) AS d90,
               SUM(o.owed) FILTER (WHERE o.late >= 91) AS d91
          FROM owed o JOIN units u ON u.id = o.unit_id
         WHERE o.owed > 0 ${q.building ? Prisma.sql`AND u.building = ${q.building}` : Prisma.empty}
         GROUP BY 1, 2, 3
         ORDER BY 3 NULLS LAST, 2 NULLS LAST`;
      const views = rows.map((r) =>
        agingRow(r.unit_id, r.unit_code, r.building, [
          money(r.not_due ?? 0),
          money(r.d30 ?? 0),
          money(r.d60 ?? 0),
          money(r.d90 ?? 0),
          money(r.d91 ?? 0),
        ]),
      );
      return {
        asOf: today,
        rows: views,
        totals: agingRow(null, null, null, [
          sum(views.map((v) => money(v.notDue))),
          sum(views.map((v) => money(v.days1to30))),
          sum(views.map((v) => money(v.days31to60))),
          sum(views.map((v) => money(v.days61to90))),
          sum(views.map((v) => money(v.days91plus))),
        ]),
      };
    });
  }

  async agingCsv(q: UnitReportQueryDto): Promise<CsvDownload> {
    const v = await this.aging(q);
    return csv(
      `aging-${v.asOf}.csv`,
      [
        ...unitColumns(q),
        { header: 'not_due', kind: 'number' },
        { header: 'days_1_30', kind: 'number' },
        { header: 'days_31_60', kind: 'number' },
        { header: 'days_61_90', kind: 'number' },
        { header: 'days_91_plus', kind: 'number' },
        { header: 'total', kind: 'number' },
      ],
      [...v.rows, { ...v.totals, unitCode: 'TOTAL' }].map((r) => [
        ...unitCells(q, r),
        r.notDue,
        r.days1to30,
        r.days31to60,
        r.days61to90,
        r.days91plus,
        r.total,
      ]),
    );
  }

  // --------------------------------------------------------------------------
  // Collections
  // --------------------------------------------------------------------------

  /**
   * Money received in a period by channel and method, per day or month: a
   * payment counts on the day it was paid, a reversal on the day it was
   * recorded (the compound's local days).
   */
  collections(q: CollectionsQueryDto): Promise<CollectionsView> {
    checkPeriod(q);
    return this.tenantTx.withTenantTx(async (tx) => {
      const tz = await this.timezone(tx);
      const bucket = (d: Prisma.Sql) =>
        q.groupBy === 'month'
          ? Prisma.sql`to_char(${d}, 'YYYY-MM')`
          : Prisma.sql`to_char(${d}, 'YYYY-MM-DD')`;
      const rows = await tx.$queryRaw<
        {
          period: string;
          channel: string;
          method: string;
          payments: bigint;
          gross: Money;
          reversals: bigint;
          reversed: Money;
        }[]
      >`
        WITH events AS (
          SELECT ${bucket(Prisma.sql`p.paid_on`)} AS period, p.channel::text AS channel,
                 p.method::text AS method, 1 AS payments, p.amount AS gross,
                 0 AS reversals, 0::numeric AS reversed
            FROM finance_payments p
           WHERE p.kind = 'payment' AND p.paid_on BETWEEN ${q.from}::date AND ${q.to}::date
          UNION ALL
          SELECT ${bucket(Prisma.sql`(r.created_at AT TIME ZONE ${tz})::date`)},
                 p.channel::text, p.method::text, 0, 0, 1, p.amount
            FROM finance_payments r
            JOIN finance_payments p ON p.tenant_id = r.tenant_id AND p.id = r.reverses_id
           WHERE r.kind = 'reversal'
             AND r.created_at >= (${q.from}::date::timestamp AT TIME ZONE ${tz})
             AND r.created_at < ((${q.to}::date + 1)::timestamp AT TIME ZONE ${tz})
        )
        SELECT period, channel, method, SUM(payments) AS payments, SUM(gross) AS gross,
               SUM(reversals) AS reversals, SUM(reversed) AS reversed
          FROM events
         GROUP BY period, channel, method
         ORDER BY period, channel, method`;
      const views: CollectionRowView[] = rows.map((r) => {
        const gross = money(r.gross);
        const reversed = money(r.reversed);
        return {
          period: r.period,
          channel: r.channel,
          method: r.method,
          payments: Number(r.payments),
          gross: show(gross),
          reversals: Number(r.reversals),
          reversed: show(reversed),
          net: show(gross.sub(reversed)),
        };
      });
      const gross = sum(views.map((v) => money(v.gross)));
      const reversed = sum(views.map((v) => money(v.reversed)));
      return {
        from: q.from,
        to: q.to,
        rows: views,
        gross: show(gross),
        reversed: show(reversed),
        net: show(gross.sub(reversed)),
      };
    });
  }

  async collectionsCsv(q: CollectionsQueryDto): Promise<CsvDownload> {
    const v = await this.collections(q);
    return csv(
      `collections-${v.from}_${v.to}.csv`,
      [
        { header: 'period', kind: 'text' },
        { header: 'channel', kind: 'text' },
        { header: 'method', kind: 'text' },
        { header: 'payments', kind: 'number' },
        { header: 'gross', kind: 'number' },
        { header: 'reversals', kind: 'number' },
        { header: 'reversed', kind: 'number' },
        { header: 'net', kind: 'number' },
      ],
      [
        ...v.rows.map((r) => [
          r.period,
          r.channel,
          r.method,
          String(r.payments),
          r.gross,
          String(r.reversals),
          r.reversed,
          r.net,
        ]),
        ['TOTAL', null, null, null, v.gross, null, v.reversed, v.net],
      ],
    );
  }

  // --------------------------------------------------------------------------
  // Outstanding
  // --------------------------------------------------------------------------

  /**
   * What each unit (or building) owes today, the overdue part of it, and
   * the credit it holds. Units that owe nothing and hold nothing are left
   * out.
   */
  outstanding(q: UnitReportQueryDto): Promise<OutstandingView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const today = await this.today(tx);
      const rows = await tx.$queryRaw<
        {
          unit_id: string | null;
          unit_code: string | null;
          building: string | null;
          open_invoices: bigint;
          outstanding: Money;
          overdue: Money;
          credit: Money;
        }[]
      >`
        WITH owed AS (
          SELECT i.unit_id, COUNT(*) AS open_invoices, SUM(x.owed) AS outstanding,
                 SUM(x.owed) FILTER (WHERE i.due_on < ${today}::date) AS overdue
            FROM invoices i
            CROSS JOIN LATERAL (SELECT i.total - ${CREDITED_SQL} - ${PAID_SQL} AS owed) x
           WHERE x.owed > 0
           GROUP BY i.unit_id
        ), held AS (
          SELECT p.unit_id, SUM(${FREE_SQL}) AS credit
            FROM finance_payments p
           WHERE p.kind = 'payment'
             AND NOT EXISTS (SELECT 1 FROM finance_payments r
                              WHERE r.tenant_id = p.tenant_id AND r.reverses_id = p.id)
           GROUP BY p.unit_id
        ), per_unit AS (
          SELECT u.id AS unit_id, u.code AS unit_code, u.building,
                 COALESCE(o.open_invoices, 0) AS open_invoices,
                 COALESCE(o.outstanding, 0) AS outstanding,
                 COALESCE(o.overdue, 0) AS overdue,
                 COALESCE(h.credit, 0) AS credit
            FROM units u
            LEFT JOIN owed o ON o.unit_id = u.id
            LEFT JOIN held h ON h.unit_id = u.id
           WHERE (COALESCE(o.outstanding, 0) > 0 OR COALESCE(h.credit, 0) > 0)
             ${q.building ? Prisma.sql`AND u.building = ${q.building}` : Prisma.empty}
        )
        SELECT ${
          q.groupBy === 'building'
            ? Prisma.sql`NULL::uuid AS unit_id, NULL::text AS unit_code, building`
            : Prisma.sql`unit_id, unit_code, building`
        },
               SUM(open_invoices) AS open_invoices, SUM(outstanding) AS outstanding,
               SUM(overdue) AS overdue, SUM(credit) AS credit
          FROM per_unit
         GROUP BY 1, 2, 3
         ORDER BY 3 NULLS LAST, 2 NULLS LAST`;
      const views = rows.map((r) =>
        outstandingRow(
          r.unit_id,
          r.unit_code,
          r.building,
          Number(r.open_invoices),
          money(r.outstanding),
          money(r.overdue),
          money(r.credit),
        ),
      );
      return {
        asOf: today,
        rows: views,
        totals: outstandingRow(
          null,
          null,
          null,
          views.reduce((n, v) => n + v.openInvoices, 0),
          sum(views.map((v) => money(v.outstanding))),
          sum(views.map((v) => money(v.overdue))),
          sum(views.map((v) => money(v.credit))),
        ),
      };
    });
  }

  async outstandingCsv(q: UnitReportQueryDto): Promise<CsvDownload> {
    const v = await this.outstanding(q);
    return csv(
      `outstanding-${v.asOf}.csv`,
      [
        ...unitColumns(q),
        { header: 'open_invoices', kind: 'number' },
        { header: 'outstanding', kind: 'number' },
        { header: 'overdue', kind: 'number' },
        { header: 'credit', kind: 'number' },
        { header: 'net', kind: 'number' },
      ],
      [...v.rows, { ...v.totals, unitCode: 'TOTAL' }].map((r) => [
        ...unitCells(q, r),
        String(r.openInvoices),
        r.outstanding,
        r.overdue,
        r.credit,
        r.net,
      ]),
    );
  }

  // --------------------------------------------------------------------------
  // Daily cash
  // --------------------------------------------------------------------------

  /**
   * The office's day for its closing, per recorder and method: payments
   * recorded that local day (whatever day they say they were paid), their
   * reversals recorded that day, and cash refunds recorded that day less
   * those reversed that day (ADR 0048: cash refunds leave the drawer).
   */
  dailyCash(q: DailyCashQueryDto): Promise<DailyCashView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const tz = await this.timezone(tx);
      const day = q.day ?? (await localToday(tx, tz));
      const since = Prisma.sql`(${day}::date::timestamp AT TIME ZONE ${tz})`;
      const until = Prisma.sql`((${day}::date + 1)::timestamp AT TIME ZONE ${tz})`;
      const events = await tx.$queryRaw<
        {
          at: Date;
          kind: 'payment' | 'reversal' | 'refund' | 'refund_reversal';
          prefix: 'receipt' | 'refund';
          number: number;
          unit_id: string;
          method: string;
          amount: Money;
          reference: string | null;
          recorded_by: string;
        }[]
      >`
        SELECT * FROM (
          SELECT p.created_at AS at, 'payment' AS kind, 'receipt' AS prefix,
                 p.receipt_number AS number, p.unit_id, p.method::text AS method,
                 p.amount, p.reference, p.recorded_by_account_id AS recorded_by
            FROM finance_payments p
           WHERE p.kind = 'payment' AND p.channel = 'office'
             AND p.created_at >= ${since} AND p.created_at < ${until}
          UNION ALL
          SELECT r.created_at, 'reversal', 'receipt', p.receipt_number, r.unit_id,
                 p.method::text, -p.amount, p.reference, r.recorded_by_account_id
            FROM finance_payments r
            JOIN finance_payments p ON p.tenant_id = r.tenant_id AND p.id = r.reverses_id
           WHERE r.kind = 'reversal'
             AND r.created_at >= ${since} AND r.created_at < ${until}
          UNION ALL
          SELECT f.created_at, 'refund', 'refund', f.number, f.unit_id, 'cash',
                 -f.amount, f.reference, f.recorded_by_account_id
            FROM finance_refunds f
           WHERE f.kind = 'refund' AND f.channel = 'cash'
             AND f.created_at >= ${since} AND f.created_at < ${until}
          UNION ALL
          SELECT r.created_at, 'refund_reversal', 'refund', f.number, r.unit_id, 'cash',
                 f.amount, f.reference, r.recorded_by_account_id
            FROM finance_refunds r
            JOIN finance_refunds f ON f.tenant_id = r.tenant_id AND f.id = r.reverses_id
           WHERE r.kind = 'reversal' AND f.channel = 'cash'
             AND r.created_at >= ${since} AND r.created_at < ${until}
        ) e ORDER BY e.at, e.number`;
      const [units, names] = [
        await this.community.units(
          tx,
          events.map((e) => e.unit_id),
        ),
        await this.community.staffNames(
          tx,
          events.map((e) => e.recorded_by),
        ),
      ];
      const ref = (id: string) => ({ id, fullName: names.get(id) ?? null });
      const byKey = new Map<string, CashierRowView>();
      for (const e of events) {
        const key = `${e.recorded_by}|${e.method}`;
        const row =
          byKey.get(key) ??
          byKey
            .set(key, {
              recordedBy: ref(e.recorded_by),
              method: e.method,
              payments: 0,
              received: '0.00',
              reversals: 0,
              reversed: '0.00',
              refunds: 0,
              refunded: '0.00',
              net: '0.00',
            })
            .get(key)!;
        const amount = money(e.amount);
        if (e.kind === 'payment') {
          row.payments += 1;
          row.received = show(money(row.received).add(amount));
        } else if (e.kind === 'reversal') {
          row.reversals += 1;
          row.reversed = show(money(row.reversed).sub(amount));
        } else {
          row.refunds += e.kind === 'refund' ? 1 : -1;
          row.refunded = show(money(row.refunded).sub(amount));
        }
        row.net = show(money(row.net).add(amount));
      }
      const rows = [...byKey.values()].sort(
        (a, b) =>
          (a.recordedBy.fullName ?? '').localeCompare(
            b.recordedBy.fullName ?? '',
          ) || a.method.localeCompare(b.method),
      );
      const eventViews: CashEventView[] = events.map((e) => ({
        at: e.at,
        kind: e.kind,
        number: formatNumber(e.prefix, e.number),
        unitCode: units.get(e.unit_id)?.code ?? '',
        method: e.method,
        amount: show(money(e.amount)),
        reference: e.reference,
        recordedBy: ref(e.recorded_by),
      }));
      return {
        day,
        rows,
        events: eventViews,
        net: show(sum(rows.map((r) => money(r.net)))),
      };
    });
  }

  async dailyCashCsv(q: DailyCashQueryDto): Promise<CsvDownload> {
    const v = await this.dailyCash(q);
    return csv(
      `daily-cash-${v.day}.csv`,
      [
        { header: 'recorded_at', kind: 'text' },
        { header: 'kind', kind: 'text' },
        { header: 'number', kind: 'text' },
        { header: 'unit', kind: 'text' },
        { header: 'method', kind: 'text' },
        { header: 'reference', kind: 'text' },
        { header: 'recorded_by', kind: 'text' },
        { header: 'amount', kind: 'number' },
      ],
      [
        ...v.events.map((e) => [
          e.at.toISOString(),
          e.kind,
          e.number,
          e.unitCode,
          e.method,
          e.reference,
          e.recordedBy.fullName,
          e.amount,
        ]),
        [v.day, 'TOTAL', null, null, null, null, null, v.net],
      ],
    );
  }

  // --------------------------------------------------------------------------

  private async timezone(tx: TenantTxClient): Promise<string> {
    return (await this.tenantSettings.inTx(tx, this.ctx.txTenantId)).timezone;
  }

  private async today(tx: TenantTxClient): Promise<LocalDate> {
    return localToday(tx, await this.timezone(tx));
  }

  /** The three grouping columns: the unit's, or the building's alone. */
  private groupKey(q: UnitReportQueryDto): Prisma.Sql {
    return q.groupBy === 'building'
      ? Prisma.sql`NULL::uuid AS unit_id, NULL::text AS unit_code, u.building`
      : Prisma.sql`u.id AS unit_id, u.code AS unit_code, u.building`;
  }
}

function agingRow(
  unitId: string | null,
  unitCode: string | null,
  building: string | null,
  b: [Money, Money, Money, Money, Money],
): AgingRowView {
  return {
    unitId,
    unitCode,
    building,
    notDue: show(b[0]),
    days1to30: show(b[1]),
    days31to60: show(b[2]),
    days61to90: show(b[3]),
    days91plus: show(b[4]),
    total: show(sum(b)),
  };
}

function outstandingRow(
  unitId: string | null,
  unitCode: string | null,
  building: string | null,
  openInvoices: number,
  outstanding: Money,
  overdue: Money,
  credit: Money,
): OutstandingRowView {
  return {
    unitId,
    unitCode,
    building,
    openInvoices,
    outstanding: show(outstanding),
    overdue: show(overdue),
    credit: show(credit),
    net: show(outstanding.sub(credit)),
  };
}

function unitColumns(q: UnitReportQueryDto): CsvColumn[] {
  return q.groupBy === 'building'
    ? [{ header: 'building', kind: 'text' }]
    : [
        { header: 'unit', kind: 'text' },
        { header: 'building', kind: 'text' },
      ];
}

function unitCells(
  q: UnitReportQueryDto,
  r: { unitCode: string | null; building: string | null },
): (string | null)[] {
  return q.groupBy === 'building'
    ? [r.unitCode === 'TOTAL' ? 'TOTAL' : r.building]
    : [r.unitCode, r.building];
}
