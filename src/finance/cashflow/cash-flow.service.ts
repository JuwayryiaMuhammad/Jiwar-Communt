import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { toCsv, type CsvColumn } from '../../core/common/csv';
import { FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import type { LocalDate } from '../../core/common/slots/day-slots';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { PayablesBridge } from '../../core/payables/payables-bridge';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { fromDate, localToday } from '../db-clock';
import { CREDITED_SQL, DISPUTED_SQL, PAID_SQL } from '../invoices/balances';
import { CURRENCY, money, show, ZERO } from '../money';
import type { CsvDownload } from '../reports/reports.service';
import { OPEN_CUSTODY } from '../treasury/custody.service';
import {
  CASH_FLOW_PERIODS,
  closings,
  collectionRate,
  dailySpending,
  expectedOf,
  liquidityDays,
  periodIndex,
  periodsFrom,
  planPeriods,
  splitRetention,
  windowBefore,
  type CashFlowBy,
  type CashFlowPeriod,
} from './cash-flow-rules';

type Money = Prisma.Decimal;

const FREQUENCY_MONTHS = { monthly: 1, quarterly: 3, annual: 12 } as const;

export interface CashFlowInflows {
  /** Issued invoices still owed, due in the period (none under an open dispute). */
  invoiced: Money;
  /** What the billing plans will issue, due in the period (ADR 0069). */
  projected: Money;
  /** invoiced + projected, at their face. */
  dues: Money;
  /** dues at the collection rate. */
  expected: Money;
  /** Money collected and not yet in an account: the first period only. */
  inTransit: Money;
  /** expected + inTransit. */
  total: Money;
}

export interface CashFlowOutflows {
  /** Approved vendors' invoices, less the retention their payout holds back. */
  vendorInvoices: Money;
  /** Contracts' unpaid schedule payments no approved invoice names, less retention. */
  contractPayments: Money;
  /** What open commitments of approved purchases still keep. */
  purchases: Money;
  /** Advances and retention releases asked for or approved, not yet paid. */
  disbursements: Money;
  /** The retention a contract holds, due at its end. */
  retentions: Money;
  total: Money;
}

export interface CashFlowRow extends CashFlowPeriod {
  inflows: CashFlowInflows;
  outflows: CashFlowOutflows;
  net: Money;
  closing: Money;
  /** The closing balance is below the compound's minimum. */
  belowMinimum: boolean;
}

export interface CashFlowForecast {
  asOf: LocalDate;
  timeZone: string;
  currency: string;
  by: CashFlowBy;
  opening: {
    total: Money;
    accounts: { id: string; name: string; kind: string; balance: Money }[];
  };
  collection: {
    rate: number | null;
    basis: 'window' | 'no_history';
    from: LocalDate;
    to: LocalDate;
    due: Money;
    collected: Money;
  };
  spending: { from: LocalDate; to: LocalDate; total: Money; daily: Money };
  liquidityDays: number | null;
  minimumCash: Money | null;
  /** The cash on hand is below the minimum now. */
  belowMinimumNow: boolean;
  /** The first day of the first period closing below the minimum. */
  firstBelowMinimum: LocalDate | null;
  periodsBelowMinimum: number;
  overdue: {
    /** Approved invoices and schedule payments past their day: in the first period. */
    payables: { count: number; amount: Money };
    /** Residents' dues past their day: not counted. */
    receivables: Money;
  };
  /** Residents' dues under an open dispute, due in the horizon: not counted. */
  disputed: Money;
  periods: CashFlowRow[];
  totals: { inflows: Money; outflows: Money; net: Money; closing: Money };
}

export interface CashFlowSettings {
  minimumCash: string | null;
  /** When the current dip below the minimum began, or null. */
  lowSince: Date | null;
  toldAt: Date | null;
}

const EXPORT_COLUMNS: readonly CsvColumn[] = [
  { header: 'from', kind: 'text' },
  { header: 'to', kind: 'text' },
  { header: 'invoiced', kind: 'number' },
  { header: 'projected', kind: 'number' },
  { header: 'expected', kind: 'number' },
  { header: 'in_transit', kind: 'number' },
  { header: 'inflows', kind: 'number' },
  { header: 'vendor_invoices', kind: 'number' },
  { header: 'contract_payments', kind: 'number' },
  { header: 'purchases', kind: 'number' },
  { header: 'disbursements', kind: 'number' },
  { header: 'retentions', kind: 'number' },
  { header: 'outflows', kind: 'number' },
  { header: 'net', kind: 'number' },
  { header: 'closing', kind: 'number' },
  { header: 'below_minimum', kind: 'text' },
];

const blankIn = (): CashFlowInflows => ({
  invoiced: ZERO,
  projected: ZERO,
  dues: ZERO,
  expected: ZERO,
  inTransit: ZERO,
  total: ZERO,
});
const blankOut = (): CashFlowOutflows => ({
  vendorInvoices: ZERO,
  contractPayments: ZERO,
  purchases: ZERO,
  disbursements: ZERO,
  retentions: ZERO,
  total: ZERO,
});

/**
 * The cash flow forecast and liquidity (ADR 0091), computed when asked,
 * never stored, in the caller's tenant transaction (RLS):
 *
 * - **the opening position** is the bank and cash accounts' balances (the
 *   sums of their movements, ADR 0085);
 * - **the outflows** are what payables already schedules (ADR 0077, 0089):
 *   approved vendors' invoices by their due day, the contracts' unpaid
 *   schedule payments, what approved purchases' commitments still keep,
 *   advances and retention releases asked for or approved, and the
 *   retention a contract holds, at its end. Nothing else is invented;
 * - **the inflows** are the residents' dues by their due day — issued
 *   invoices still owed (instalments are invoices) and the periods the
 *   billing plans will issue — at the compound's collection rate of the 90
 *   days before today, and what was collected but is not in an account yet
 *   (custody not handed in, cheques that paid and have not cleared).
 *
 * Totals of the compound only: never a unit, a resident or a payer.
 */
@Injectable()
export class CashFlowService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly settings: TenantSettingsService,
    private readonly bridge: PayablesBridge,
    private readonly access: FinanceAccess,
    private readonly audit: AuditService,
  ) {}

  forecast(q: {
    by?: CashFlowBy;
    periods?: number;
  }): Promise<CashFlowForecast> {
    const by = q.by ?? 'week';
    const count = q.periods ?? CASH_FLOW_PERIODS[by].default;
    const { min, max } = CASH_FLOW_PERIODS[by];
    if (count < min || count > max)
      throw invalid([
        {
          field: 'periods',
          code: FieldErrorCode.INVALID_NUMBER,
          params: { min, max },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      return this.read(tx, {
        today: await localToday(tx, timezone),
        timeZone: timezone,
        by,
        count,
      });
    });
  }

  async csv(q: { by?: CashFlowBy; periods?: number }): Promise<CsvDownload> {
    const f = await this.forecast(q);
    return {
      name: `cash-flow-${f.asOf}-${f.by}.csv`,
      body: toCsv(
        EXPORT_COLUMNS,
        f.periods.map((p) => [
          p.from,
          p.to,
          show(p.inflows.invoiced),
          show(p.inflows.projected),
          show(p.inflows.expected),
          show(p.inflows.inTransit),
          show(p.inflows.total),
          show(p.outflows.vendorInvoices),
          show(p.outflows.contractPayments),
          show(p.outflows.purchases),
          show(p.outflows.disbursements),
          show(p.outflows.retentions),
          show(p.outflows.total),
          show(p.net),
          show(p.closing),
          p.belowMinimum ? 'yes' : 'no',
        ]),
      ),
    };
  }

  settingsView(): Promise<CashFlowSettings> {
    return this.tenantTx.withTenantTx(async (tx) =>
      settingsOf(
        await tx.financeSettings.findUniqueOrThrow({
          where: { tenantId: this.ctx.txTenantId },
        }),
      ),
    );
  }

  /**
   * The compound's floor (`finance.treasury`); null turns it and its notice
   * off, ending a dip in course. Under the settings row's lock, as the
   * sweep takes it: a change and a sweep take turns.
   */
  setMinimum(minimumCash: string | null): Promise<CashFlowSettings> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const tenantId = this.ctx.txTenantId;
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings
         WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
      const before = await tx.financeSettings.findUniqueOrThrow({
        where: { tenantId },
      });
      const from = before.cashMinimum ? show(before.cashMinimum) : null;
      const to = minimumCash === null ? null : show(minimumCash);
      if (from === to) return settingsOf(before);
      const after = await tx.financeSettings.update({
        where: { tenantId },
        data: {
          cashMinimum: to,
          ...(to === null ? { cashLowSince: null } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'cash_flow.settings_changed',
        targetId: tenantId,
        changes: diffChanges(
          { minimumCash: from },
          { minimumCash: to },
          'cash_flow.settings_changed',
        ),
      });
      return settingsOf(after);
    });
  }

  /**
   * Days of spending the cash covers, in the caller's transaction (the
   * dashboard's): the live accounts' balances over the window's average
   * daily spending. Two aggregate queries.
   */
  async liquidityIn(
    tx: TenantTxClient,
    today: LocalDate,
  ): Promise<number | null> {
    const cash = await this.cashOnHand(tx);
    const spent = await this.spent(tx, today);
    return liquidityDays(cash.total, spent, cash.live > 0);
  }

  /** The forecast, in the caller's transaction (the dashboard's and the sweep's). */
  async read(
    tx: TenantTxClient,
    q: { today: LocalDate; timeZone: string; by: CashFlowBy; count: number },
  ): Promise<CashFlowForecast> {
    const { today } = q;
    const periods = periodsFrom(q.by, q.count, today);
    const end = periods[periods.length - 1].to;
    const rows: CashFlowRow[] = periods.map((p) => ({
      ...p,
      inflows: blankIn(),
      outflows: blankOut(),
      net: ZERO,
      closing: ZERO,
      belowMinimum: false,
    }));
    const at = (day: LocalDate | null) =>
      day === null ? rows[0] : rows[periodIndex(periods, day)];

    const settings = await tx.financeSettings.findFirstOrThrow({
      select: { cashMinimum: true },
    });
    const minimum = settings.cashMinimum ? money(settings.cashMinimum) : null;

    // The opening position: every account's balance (ADR 0085).
    const accounts = await tx.$queryRaw<
      { id: string; name: string; kind: string; balance: Money }[]
    >`
      SELECT a.id, a.name, a.kind, COALESCE(SUM(m.amount), 0) AS balance
        FROM finance_cash_accounts a
        LEFT JOIN finance_cash_movements m ON m.account_id = a.id
       WHERE a.retired_at IS NULL
       GROUP BY a.id, a.name, a.kind
       ORDER BY a.name, a.id`;
    const opening = accounts.reduce((s, a) => s.add(a.balance), ZERO);

    // The collection rate: of what fell due in the window, the share paid.
    const window = windowBefore(today);
    const [hist] = await tx.$queryRaw<{ due: Money; collected: Money }[]>`
      WITH w AS (
        SELECT GREATEST(i.total - ${CREDITED_SQL}, 0) AS due, ${PAID_SQL} AS paid
          FROM invoices i
         WHERE i.due_on BETWEEN ${window.from}::date AND ${window.to}::date
      )
      SELECT COALESCE(SUM(due), 0) AS due,
             COALESCE(SUM(LEAST(GREATEST(paid, 0), due)), 0) AS collected
        FROM w`;
    const rate = collectionRate(hist.due, hist.collected);

    // The residents' dues still owed, by their day.
    const owed = await tx.$queryRaw<
      { due_on: Date; disputed: boolean; owed: Money }[]
    >`
      WITH o AS (
        SELECT i.due_on, ${DISPUTED_SQL} AS disputed,
               i.total - ${CREDITED_SQL} - ${PAID_SQL} AS owed
          FROM invoices i
         WHERE i.due_on <= ${end}::date
      )
      SELECT due_on, disputed, SUM(owed) AS owed FROM o
       WHERE owed > 0 GROUP BY due_on, disputed`;
    let overdueReceivable = ZERO;
    let disputed = ZERO;
    for (const o of owed) {
      const day = fromDate(o.due_on);
      if (day < today) overdueReceivable = overdueReceivable.add(o.owed);
      else if (o.disputed) disputed = disputed.add(o.owed);
      else at(day).inflows.invoiced = at(day).inflows.invoiced.add(o.owed);
    }

    // What the billing plans will still issue (ADR 0069), every unit not
    // billed for a period yet and not excluded, at its own amount.
    const plans = await tx.billingPlan.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
    });
    for (const plan of plans) {
      const due = planPeriods(
        {
          frequency: plan.frequency,
          startsOn: fromDate(plan.startsOn),
          issueDaysBefore: plan.issueDaysBefore,
          dueDaysAfterIssue: plan.dueDaysAfterIssue,
        },
        FREQUENCY_MONTHS[plan.frequency],
        today,
        end,
      );
      if (!due.length) continue;
      const sums = await tx.$queryRaw<{ start: Date; amount: Money }[]>`
        SELECT s.start, COALESCE(SUM(COALESCE(o.amount, ${plan.amount})), 0) AS amount
          FROM unnest(${due.map((d) => d.start)}::date[]) AS s(start)
          CROSS JOIN units u
          LEFT JOIN billing_plan_overrides o
            ON o.tenant_id = u.tenant_id AND o.plan_id = ${plan.id}::uuid AND o.unit_id = u.id
         WHERE NOT COALESCE(o.excluded, false)
           AND NOT EXISTS (SELECT 1 FROM invoices i
                            WHERE i.tenant_id = u.tenant_id AND i.plan_id = ${plan.id}::uuid AND i.unit_id = u.id
                              AND i.period_starts_on = s.start)
         GROUP BY s.start`;
      for (const s of sums) {
        const start = fromDate(s.start);
        const day = due.find((d) => d.start === start)!.dueOn;
        const row = at(day < today ? today : day);
        row.inflows.projected = row.inflows.projected.add(s.amount);
      }
    }

    // Collected, not in an account yet: the first period.
    const [transit] = await tx.$queryRaw<{ custody: Money; cheques: Money }[]>`
      SELECT
        (SELECT COALESCE(SUM(p.amount), 0) FROM finance_payments p WHERE ${OPEN_CUSTODY}) AS custody,
        (SELECT COALESCE(SUM(c.amount), 0) FROM finance_cheques c
          WHERE c.status IN ('received', 'deposited') AND c.payment_id IS NOT NULL) AS cheques`;
    rows[0].inflows.inTransit = money(transit.custody).add(transit.cheques);

    // ---- what payables schedules out (ADR 0077, 0089)
    const invoices = await tx.$queryRaw<
      {
        due_on: Date;
        total: Money;
        contract_id: string | null;
        contract_payment_id: string | null;
      }[]
    >`
      SELECT due_on, total, contract_id, contract_payment_id
        FROM finance_vendor_invoices WHERE status = 'approved'`;
    const payments = await this.bridge.source.unpaid(tx, end);
    const invoicedPayments = new Set(
      invoices.flatMap((i) =>
        i.contract_payment_id ? [i.contract_payment_id] : [],
      ),
    );
    const disbursements = await tx.$queryRaw<
      { kind: string; contract_id: string; amount: Money }[]
    >`
      SELECT kind, contract_id, amount FROM finance_contract_disbursements
       WHERE status IN ('requested', 'approved')`;
    const held = await tx.$queryRaw<{ contract_id: string; open: Money }[]>`
      SELECT contract_id,
             COALESCE(SUM(retention_held) FILTER (WHERE kind = 'invoice'), 0)
             - COALESCE(SUM(gross) FILTER (WHERE kind = 'retention_release'), 0) AS open
        FROM finance_vendor_payouts
       WHERE contract_id IS NOT NULL
       GROUP BY contract_id`;
    const contractIds = [
      ...new Set([
        ...invoices.flatMap((i) => (i.contract_id ? [i.contract_id] : [])),
        ...payments.map((p) => p.contractId),
        ...held.map((h) => h.contract_id),
      ]),
    ].sort();
    const terms = new Map(
      (await this.bridge.source.terms(tx, contractIds)).map((t) => [t.id, t]),
    );
    /** The retention each contract will release at its end. */
    const retention = new Map<string, Money>();
    const keep = (contractId: string, amount: Money) =>
      retention.set(
        contractId,
        (retention.get(contractId) ?? ZERO).add(amount),
      );
    let overdueCount = 0;
    let overdueAmount = ZERO;
    const late = (day: LocalDate, amount: Money) => {
      if (day >= today) return;
      overdueCount += 1;
      overdueAmount = overdueAmount.add(amount);
    };

    for (const i of invoices) {
      const day = fromDate(i.due_on);
      const pct = i.contract_id
        ? (terms.get(i.contract_id)?.retentionPct ?? null)
        : null;
      const part = splitRetention(i.total, pct);
      if (i.contract_id && part.held.gt(0)) keep(i.contract_id, part.held);
      late(day, money(i.total));
      // One due after the horizon is not this forecast's.
      const n = periodIndex(periods, day);
      if (n < 0) continue;
      rows[n].outflows.vendorInvoices = rows[n].outflows.vendorInvoices.add(
        part.now,
      );
    }
    for (const p of payments) {
      if (invoicedPayments.has(p.id)) continue;
      const part = splitRetention(
        p.amount,
        terms.get(p.contractId)?.retentionPct ?? null,
      );
      if (part.held.gt(0)) keep(p.contractId, part.held);
      late(p.dueOn, money(p.amount));
      const row = at(p.dueOn);
      row.outflows.contractPayments = row.outflows.contractPayments.add(
        part.now,
      );
    }
    const purchases = await tx.$queryRaw<
      { due_on: Date | null; open: Money }[]
    >`
      SELECT c.due_on, c.amount - COALESCE((
               SELECT SUM(r.amount) FROM finance_commitment_releases r
                WHERE r.tenant_id = c.tenant_id AND r.commitment_id = c.id), 0) AS open
        FROM finance_commitments c
       WHERE c.closed_at IS NULL AND c.source IN ('purchase_request', 'purchase_order')
         AND (c.due_on IS NULL OR c.due_on <= ${end}::date)`;
    for (const c of purchases) {
      if (money(c.open).lte(0)) continue;
      const row = at(c.due_on ? fromDate(c.due_on) : null);
      row.outflows.purchases = row.outflows.purchases.add(c.open);
    }
    for (const d of disbursements) {
      rows[0].outflows.disbursements = rows[0].outflows.disbursements.add(
        d.amount,
      );
      // A release asked for is no longer the contract's to release.
      if (d.kind === 'retention_release')
        keep(d.contract_id, money(d.amount).neg());
    }
    for (const h of held) keep(h.contract_id, money(h.open));
    for (const [contractId, amount] of retention) {
      if (amount.lte(0)) continue;
      const t = terms.get(contractId);
      if (!t) continue;
      const day = t.terminated || t.endsOn < today ? today : t.endsOn;
      const i = periodIndex(periods, day);
      if (i < 0) continue;
      rows[i].outflows.retentions = rows[i].outflows.retentions.add(amount);
    }

    // ---- the periods' balances
    for (const r of rows) {
      const inn = r.inflows;
      inn.dues = inn.invoiced.add(inn.projected);
      inn.expected = expectedOf(inn.dues, rate);
      inn.total = inn.expected.add(inn.inTransit);
      const out = r.outflows;
      out.total = out.vendorInvoices
        .add(out.contractPayments)
        .add(out.purchases)
        .add(out.disbursements)
        .add(out.retentions);
      r.net = inn.total.sub(out.total);
    }
    const closing = closings(
      opening,
      rows.map((r) => r.net),
    );
    rows.forEach((r, i) => {
      r.closing = closing[i];
      r.belowMinimum = minimum !== null && r.closing.lt(minimum);
    });
    const below = rows.filter((r) => r.belowMinimum);

    const spent = await this.spent(tx, today);
    const sum = (f: (r: CashFlowRow) => Money) =>
      rows.reduce((s, r) => s.add(f(r)), ZERO);
    return {
      asOf: today,
      timeZone: q.timeZone,
      currency: CURRENCY,
      by: q.by,
      opening: {
        total: opening,
        accounts: accounts.map((a) => ({ ...a, balance: money(a.balance) })),
      },
      collection: {
        rate,
        basis: rate === null ? 'no_history' : 'window',
        from: window.from,
        to: window.to,
        due: money(hist.due),
        collected: money(hist.collected),
      },
      spending: {
        ...window,
        total: spent,
        daily: dailySpending(spent),
      },
      liquidityDays: liquidityDays(opening, spent, accounts.length > 0),
      minimumCash: minimum,
      belowMinimumNow: minimum !== null && opening.lt(minimum),
      firstBelowMinimum: below[0]?.from ?? null,
      periodsBelowMinimum: below.length,
      overdue: {
        payables: { count: overdueCount, amount: overdueAmount },
        receivables: overdueReceivable,
      },
      disputed,
      periods: rows,
      totals: {
        inflows: sum((r) => r.inflows.total),
        outflows: sum((r) => r.outflows.total),
        net: sum((r) => r.net),
        closing: rows[rows.length - 1].closing,
      },
    };
  }

  /** The live accounts' balances, and how many there are. */
  private async cashOnHand(
    tx: TenantTxClient,
  ): Promise<{ total: Money; live: number }> {
    const [row] = await tx.$queryRaw<{ total: Money | null; live: bigint }[]>`
      SELECT (SELECT SUM(m.amount) FROM finance_cash_movements m
                JOIN finance_cash_accounts a ON a.id = m.account_id
               WHERE a.retired_at IS NULL) AS total,
             (SELECT count(*) FROM finance_cash_accounts WHERE retired_at IS NULL) AS live`;
    return { total: money(row.total ?? 0), live: Number(row.live) };
  }

  /** What live expenses spent on the window's days (ADR 0055). */
  private async spent(tx: TenantTxClient, today: LocalDate): Promise<Money> {
    const w = windowBefore(today);
    const [row] = await tx.$queryRaw<{ spent: Money | null }[]>`
      SELECT SUM(amount) AS spent FROM finance_expenses
       WHERE voided_at IS NULL
         AND spent_on BETWEEN ${w.from}::date AND ${w.to}::date`;
    return money(row.spent ?? 0);
  }
}

function settingsOf(s: {
  cashMinimum: Prisma.Decimal | null;
  cashLowSince: Date | null;
  cashLowToldAt: Date | null;
}): CashFlowSettings {
  return {
    minimumCash: s.cashMinimum ? show(s.cashMinimum) : null,
    lowSince: s.cashLowSince,
    toldAt: s.cashLowToldAt,
  };
}
