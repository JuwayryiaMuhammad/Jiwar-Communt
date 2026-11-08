import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type FinanceBudget,
  type FinanceBudgetTransfer,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { toCsv, type CsvColumn } from '../../core/common/csv';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { dbNow, fromDate, localToday } from '../db-clock';
import { money, show, ZERO } from '../money';
import type { CsvDownload } from '../reports/reports.service';
import { addDays } from '../../core/common/slots/day-slots';
import { fiscalYearOf } from '../budgets/budget-rules';
import {
  BudgetsService,
  budgetLineNotFound,
  budgetNotFound,
} from '../budgets/budgets.service';
import { lineInsufficient, lockLines } from './commitments.service';
import {
  monthsFromQuarters,
  monthsOf,
  type TransferStatus,
} from './payable-rules';
import { BudgetTransferView } from './views/payables.views';

export const TRANSFER_RESOURCE = 'finance_budget_transfer';

export interface TransferRecord {
  transfer: FinanceBudgetTransfer;
  fromCategory: string;
  toCategory: string;
}

export interface PeriodCell {
  /** 1–12 for a month, 1–4 for a quarter, counted from the fiscal year's start. */
  period: number;
  from: string;
  to: string;
  planned: string;
  actual: string;
  variance: string;
  /** variance ÷ planned, a percentage with one decimal; null with nothing planned. */
  variancePct: string | null;
  /** The period ended before today. */
  closed: boolean;
  /** Past the compound's setting, closed, and not yet explained. */
  reasonMissing: boolean;
  reason: { reasonCode: string; note: string | null; month: number } | null;
}

export interface PeriodReport {
  budgetId: string;
  fiscalYear: number;
  by: 'month' | 'quarter';
  asOf: string;
  varianceReasonPct: number | null;
  lines: { lineId: string; category: string; periods: PeriodCell[] }[];
  /** How many closed periods past the setting have no reason yet. */
  missingReasons: number;
}

const transferNotFound = () =>
  appError.notFound(
    ErrorCode.BUDGET_TRANSFER_NOT_FOUND,
    'Budget transfer not found',
  );
const transferState = (status: string) =>
  appError.conflict(
    ErrorCode.BUDGET_TRANSFER_STATE,
    'The transfer is not in a state that allows this',
    { params: { status } },
  );
const notActive = (status: string) =>
  appError.conflict(ErrorCode.BUDGET_NOT_ACTIVE, 'The budget is not active', {
    params: { status },
  });

const COLUMNS: readonly CsvColumn[] = [
  { header: 'category', kind: 'text' },
  { header: 'period', kind: 'number' },
  { header: 'from', kind: 'text' },
  { header: 'to', kind: 'text' },
  { header: 'planned', kind: 'number' },
  { header: 'actual', kind: 'number' },
  { header: 'variance', kind: 'number' },
  { header: 'variance_pct', kind: 'number' },
  { header: 'reason_code', kind: 'text' },
  { header: 'reason_missing', kind: 'text' },
];

/**
 * Budget planning (ADR 0089): money moved between two lines of the active
 * budget, a line split by month (a quarter is its three months), why a
 * line ran past its plan, and the period report that asks for it.
 *
 * - A transfer within the manager's limit (major_contract's threshold,
 *   ADR 0055, read shared through core's BoardMatters) is applied at once
 *   by `finance.budget`; above it, it waits for the board: a
 *   `budget_transfer` request names it, and its approval applies it, or
 *   lapses it when the line no longer has the money.
 * - A transfer out takes only what the line has available — commitments
 *   and approved invoices kept — under both lines' locks, so a commitment
 *   and a transfer on one line never take the same money.
 *
 * Locks: the caller → the transfer (update) → the budget (shared) → the
 * lines (update, in id order) → the threshold's row (shared).
 */
@Injectable()
export class BudgetPlanningService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: FinanceAccess,
    private readonly budgets: BudgetsService,
    private readonly matters: BoardMatters,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    // A replay's body as the route answers it: the view.
    this.idempotency.renderer(TRANSFER_RESOURCE, async (id) =>
      BudgetTransferView.from(await this.getTransfer(id), this.ctx.accountId),
    );
    this.matters.registerApproval('budget_transfer', {
      subject: 'budget_transfer',
      raise: (tx, ev) => this.raised(tx, ev.requestId, ev.subjectId!),
      describe: async (tx, id) => {
        const t = id
          ? await tx.financeBudgetTransfer.findUnique({ where: { id } })
          : null;
        if (!t) return null;
        const r = await this.load(tx, t);
        const from = await this.budgets.figuresOf(
          tx,
          await tx.financeBudgetLine.findUniqueOrThrow({
            where: { id: t.fromLineId },
          }),
        );
        return {
          budgetId: t.budgetId,
          fromCategory: r.fromCategory,
          toCategory: r.toCategory,
          amount: show(t.amount),
          fromAvailable: show(from.available),
          status: t.status,
        };
      },
      decided: (tx, ev) =>
        this.decided(tx, ev.requestId, ev.subjectId!, ev.approved, ev.now),
      withdrawn: async (tx, ev) => {
        const t = await this.lockTransfer(tx, ev.subjectId!);
        if (
          !t ||
          t.status !== 'awaiting_board' ||
          t.approvalRequestId !== ev.requestId
        )
          return;
        await tx.financeBudgetTransfer.update({
          where: { id: t.id },
          data: { status: 'withdrawn', decidedAt: ev.now },
        });
        await this.audit.record(tx, {
          action: 'budget_transfer.decided',
          targetId: t.id,
          metadata: { requestId: ev.requestId, status: 'withdrawn' },
        });
      },
    });
  }

  // --------------------------------------------------------------------------
  // Transfers
  // --------------------------------------------------------------------------

  transfer(input: {
    fromLineId: string;
    toLineId: string;
    amount: string;
    reason: string;
  }): Promise<TransferRecord> {
    if (input.fromLineId === input.toLineId)
      throw invalid([
        { field: 'toLineId', code: FieldErrorCode.DUPLICATE_VALUE },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const lines = await lockLines(tx, this.budgets, [
        input.fromLineId,
        input.toLineId,
      ]);
      const from = lines.get(input.fromLineId);
      const to = lines.get(input.toLineId);
      if (!from || !to) throw budgetLineNotFound();
      if (from.budgetId !== to.budgetId)
        throw invalid([
          { field: 'toLineId', code: FieldErrorCode.BUDGET_LINE_NOT_AVAILABLE },
        ]);
      const budget = await tx.financeBudget.findUniqueOrThrow({
        where: { id: from.budgetId },
      });
      if (budget.status !== 'active') throw notActive(budget.status);
      const amount = money(input.amount);
      const { available } = await this.budgets.figuresOf(tx, from);
      if (amount.gt(available)) throw lineInsufficient(available);
      const limit = await this.matters.threshold(tx, 'major_contract');
      const board = limit !== null && amount.gt(limit);
      const id = newId();
      await this.idempotency.claim(tx, { type: TRANSFER_RESOURCE, id });
      const now = await dbNow(tx);
      const status: TransferStatus = board ? 'awaiting_board' : 'applied';
      const t = await tx.financeBudgetTransfer.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          budgetId: budget.id,
          fromLineId: from.id,
          toLineId: to.id,
          amount: input.amount,
          reason: input.reason.trim(),
          status,
          requestedById: this.ctx.accountId,
          requestedAt: now,
          decidedAt: board ? null : now,
        },
      });
      await this.audit.record(tx, {
        action: board ? 'budget_transfer.requested' : 'budget_transfer.applied',
        targetId: id,
        metadata: {
          budgetId: budget.id,
          fromLineId: from.id,
          toLineId: to.id,
          amount: show(amount),
          ...(board ? { limit } : {}),
        },
        ...(board ? { changes: { reason: { changed: true } } } : {}),
      });
      return this.load(tx, t);
    });
  }

  /** Called off before it is put to the board; after, governance withdraws it. */
  cancelTransfer(id: string): Promise<TransferRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const t = await this.lockTransfer(tx, id);
      if (!t) throw transferNotFound();
      if (t.status !== 'awaiting_board' || t.approvalRequestId)
        throw transferState(t.approvalRequestId ? 'raised' : t.status);
      const done = await tx.financeBudgetTransfer.update({
        where: { id },
        data: { status: 'withdrawn', decidedAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'budget_transfer.cancelled',
        targetId: id,
        metadata: { budgetId: t.budgetId },
      });
      return this.load(tx, done);
    });
  }

  listTransfers(budgetId: string): Promise<TransferRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeBudgetTransfer.findMany({
        where: { budgetId },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        take: 200,
      });
      const out: TransferRecord[] = [];
      for (const t of rows) out.push(await this.load(tx, t));
      return out;
    });
  }

  getTransfer(id: string): Promise<TransferRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const t = await tx.financeBudgetTransfer.findUnique({ where: { id } });
      if (!t) throw transferNotFound();
      return this.load(tx, t);
    });
  }

  private async raised(
    tx: TenantTxClient,
    requestId: string,
    id: string,
  ): Promise<{ cost: string }> {
    const t = await this.lockTransfer(tx, id);
    if (!t) throw transferNotFound();
    if (t.status !== 'awaiting_board' || t.approvalRequestId)
      throw transferState(t.approvalRequestId ? 'raised' : t.status);
    await tx.financeBudgetTransfer.update({
      where: { id },
      data: { approvalRequestId: requestId },
    });
    return { cost: show(t.amount) };
  }

  /** The board's decision; never throws for the lines' state (ADR 0055). */
  private async decided(
    tx: TenantTxClient,
    requestId: string,
    id: string,
    approved: boolean,
    now: Date,
  ): Promise<{ implemented: boolean }> {
    const t = await this.lockTransfer(tx, id);
    if (
      !t ||
      t.status !== 'awaiting_board' ||
      t.approvalRequestId !== requestId
    )
      return { implemented: false };
    let status: TransferStatus = 'rejected';
    if (approved) {
      const lines = await lockLines(tx, this.budgets, [
        t.fromLineId,
        t.toLineId,
      ]);
      const budget = await tx.financeBudget.findUniqueOrThrow({
        where: { id: t.budgetId },
      });
      const { available } = await this.budgets.figuresOf(
        tx,
        lines.get(t.fromLineId)!,
      );
      status =
        budget.status === 'active' && money(t.amount).lte(available)
          ? 'applied'
          : 'lapsed';
    }
    await tx.financeBudgetTransfer.update({
      where: { id },
      data: { status, decidedAt: now },
    });
    await this.audit.record(tx, {
      action: 'budget_transfer.decided',
      targetId: id,
      metadata: { requestId, status, amount: show(t.amount) },
    });
    return { implemented: status === 'applied' };
  }

  private async lockTransfer(
    tx: TenantTxClient,
    id: string,
  ): Promise<FinanceBudgetTransfer | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM finance_budget_transfers WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.financeBudgetTransfer.findUniqueOrThrow({ where: { id } });
  }

  private async load(
    tx: TenantTxClient,
    t: FinanceBudgetTransfer,
  ): Promise<TransferRecord> {
    const lines = await tx.financeBudgetLine.findMany({
      where: { id: { in: [t.fromLineId, t.toLineId] } },
      select: { id: true, category: true },
    });
    const cat = new Map(lines.map((l) => [l.id, l.category]));
    return {
      transfer: t,
      fromCategory: cat.get(t.fromLineId)!,
      toCategory: cat.get(t.toLineId)!,
    };
  }

  // --------------------------------------------------------------------------
  // Months, variances and the setting
  // --------------------------------------------------------------------------

  /**
   * The active budget's lines split by month, or by quarter (each a third
   * on its months): each line's split adds up to its amount. A line left
   * out keeps its split; `months: null` splits it evenly again.
   */
  phase(
    budgetId: string,
    lines: readonly {
      lineId: string;
      months?: string[] | null;
      quarters?: string[];
    }[],
  ): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const budget = await this.budgets.lock(tx, budgetId, 'update');
      if (budget.status !== 'active') throw notActive(budget.status);
      const fields: FieldError[] = [];
      const plan: { lineId: string; months: Prisma.Decimal[] | null }[] = [];
      for (const [i, l] of lines.entries()) {
        const line = await tx.financeBudgetLine.findUnique({
          where: { id: l.lineId },
        });
        if (!line || line.budgetId !== budgetId) {
          fields.push({
            field: `lines.${i}.lineId`,
            code: FieldErrorCode.BUDGET_LINE_NOT_AVAILABLE,
          });
          continue;
        }
        const has = [l.months !== undefined, l.quarters !== undefined];
        if (has[0] === has[1]) {
          fields.push({
            field: `lines.${i}.months`,
            code: FieldErrorCode.FIELD_REQUIRED,
          });
          continue;
        }
        const months =
          l.months === null
            ? null
            : l.months
              ? l.months.map((m) => money(m))
              : monthsFromQuarters(l.quarters!);
        if (months) {
          const want = l.months ? 12 : 4;
          const got = l.months ? l.months.length : l.quarters!.length;
          const total = months.reduce((a, m) => a.add(m), ZERO);
          if (got !== want || !total.equals(line.amount))
            fields.push({
              field: `lines.${i}.${l.months ? 'months' : 'quarters'}`,
              code: FieldErrorCode.INVALID_VALUE,
              params: { count: want, total: show(line.amount) },
            });
        }
        plan.push({ lineId: line.id, months });
      }
      if (new Set(lines.map((l) => l.lineId)).size !== lines.length)
        fields.push({ field: 'lines', code: FieldErrorCode.DUPLICATE_VALUE });
      if (fields.length) throw invalid(fields);
      for (const p of plan) {
        await tx.financeBudgetLineMonth.deleteMany({
          where: { lineId: p.lineId },
        });
        if (p.months)
          await tx.financeBudgetLineMonth.createMany({
            data: p.months.map((amount, k) => ({
              tenantId: this.ctx.txTenantId,
              lineId: p.lineId,
              month: k + 1,
              amount: show(amount),
            })),
          });
      }
      await this.audit.record(tx, {
        action: 'budget.phased',
        targetId: budgetId,
        metadata: { lines: plan.length },
      });
    });
  }

  /** Why a line ran past its plan in a month of the active budget. */
  explain(
    lineId: string,
    input: { month: number; reasonCode?: string; note?: string },
  ): Promise<void> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.budgetVariance,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const line = await tx.financeBudgetLine.findUnique({
        where: { id: lineId },
      });
      if (!line) throw budgetLineNotFound();
      const budget = await tx.financeBudget.findUniqueOrThrow({
        where: { id: line.budgetId },
      });
      if (budget.status !== 'active') throw notActive(budget.status);
      const note = input.note?.trim() || null;
      await tx.financeBudgetVarianceNote.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          lineId,
          month: input.month,
          reasonCode: reason,
          note,
          recordedById: this.ctx.accountId,
          recordedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'budget_line.variance_explained',
        targetId: lineId,
        metadata: { month: input.month, reasonCode: reason },
        ...(note ? { changes: { note: { changed: true } } } : {}),
      });
    });
  }

  async variancePct(): Promise<number | null> {
    return this.tenantTx.withTenantTx(
      async (tx) =>
        (
          await tx.financeSettings.findUniqueOrThrow({
            where: { tenantId: this.ctx.txTenantId },
          })
        ).varianceReasonPct,
    );
  }

  /** Past this share of a month's plan a reason is asked for; null: never. */
  setVariancePct(pct: number | null): Promise<number | null> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`
        SELECT tenant_id FROM finance_settings
         WHERE tenant_id = ${this.ctx.tenantId}::uuid FOR UPDATE`;
      const before = await tx.financeSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.tenantId },
      });
      if (before.varianceReasonPct === pct) return pct;
      await tx.financeSettings.update({
        where: { tenantId: this.ctx.tenantId },
        data: { varianceReasonPct: pct },
      });
      await this.audit.record(tx, {
        action: 'budget.settings_changed',
        targetId: this.ctx.tenantId,
        changes: diffChanges(
          { varianceReasonPct: before.varianceReasonPct },
          { varianceReasonPct: pct },
          'budget.settings_changed',
        ),
      });
      return pct;
    });
  }

  // --------------------------------------------------------------------------
  // The period report
  // --------------------------------------------------------------------------

  /**
   * Per line and month (or quarter): what was planned — its month's share,
   * with the increases and transfers the month brought (by their day) —
   * what was spent (live expenses by their day), the variance, and whether
   * a closed period past the compound's setting is still unexplained.
   */
  periods(q: {
    budgetId?: string;
    by?: 'month' | 'quarter';
  }): Promise<PeriodReport> {
    const by = q.by ?? 'month';
    return this.tenantTx.withTenantTx(async (tx) => {
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = await localToday(tx, timezone);
      const settings = await tx.financeSettings.findUniqueOrThrow({
        where: { tenantId: this.ctx.txTenantId },
      });
      const found: FinanceBudget | null = q.budgetId
        ? await tx.financeBudget.findUnique({ where: { id: q.budgetId } })
        : await tx.financeBudget.findFirst({
            where: {
              fiscalYear: fiscalYearOf(today, settings.fiscalYearStartMonth),
              status: 'active',
            },
          });
      if (!found) throw budgetNotFound();
      const budget: FinanceBudget = found;
      const startsOn = fromDate(budget.startsOn);
      const lines = (await this.budgets.load(tx, budget)).lines;
      const ids = lines.map((f) => f.line.id);
      const stored = await tx.financeBudgetLineMonth.findMany({
        where: { lineId: { in: ids } },
      });
      // Each month's first day, the year's first month first.
      const firsts = monthFirsts(startsOn);
      const monthOf = (day: string) => {
        let k = 0;
        while (k < 11 && day >= firsts[k + 1]) k++;
        return k;
      };
      const zero12 = () => Array.from({ length: 12 }, () => ZERO);
      const sums = await tx.$queryRaw<
        { line_id: string; day: Date; kind: string; amount: Prisma.Decimal }[]
      >`
        SELECT e.budget_line_id AS line_id, e.spent_on AS day, 'actual' AS kind, e.amount
          FROM finance_expenses e
         WHERE e.budget_line_id = ANY(${ids}::uuid[]) AND e.voided_at IS NULL
        UNION ALL
        SELECT a.line_id, (a.created_at AT TIME ZONE ${timezone})::date, 'plan', a.amount
          FROM finance_budget_adjustments a WHERE a.line_id = ANY(${ids}::uuid[])
        UNION ALL
        SELECT t.to_line_id, (t.decided_at AT TIME ZONE ${timezone})::date, 'plan', t.amount
          FROM finance_budget_transfers t
         WHERE t.to_line_id = ANY(${ids}::uuid[]) AND t.status = 'applied'
        UNION ALL
        SELECT t.from_line_id, (t.decided_at AT TIME ZONE ${timezone})::date, 'plan', -t.amount
          FROM finance_budget_transfers t
         WHERE t.from_line_id = ANY(${ids}::uuid[]) AND t.status = 'applied'`;
      const notes = await tx.financeBudgetVarianceNote.findMany({
        where: { lineId: { in: ids } },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      });
      const pct = settings.varianceReasonPct;
      let missing = 0;
      const out = lines.map((f) => {
        const planned = monthsOf(
          f.line.amount,
          stored.filter((m) => m.lineId === f.line.id),
        );
        const actual = zero12();
        for (const s of sums.filter((x) => x.line_id === f.line.id)) {
          const k = monthOf(fromDate(s.day));
          if (s.kind === 'actual') actual[k] = actual[k].add(s.amount);
          else planned[k] = planned[k].add(s.amount);
        }
        const groups =
          by === 'month'
            ? firsts.map((_, k) => [k])
            : [0, 1, 2, 3].map((g) => [g * 3, g * 3 + 1, g * 3 + 2]);
        const periods: PeriodCell[] = groups.map((ks, g) => {
          const p = ks.reduce((a, k) => a.add(planned[k]), ZERO);
          const a = ks.reduce((x, k) => x.add(actual[k]), ZERO);
          const from = firsts[ks[0]];
          const last = ks[ks.length - 1];
          const to =
            last === 11
              ? fromDate(budget.endsOn)
              : addDays(firsts[last + 1], -1);
          const variance = a.sub(p);
          const vp = p.isZero() ? null : variance.mul(100).div(p).toFixed(1);
          const closed = to < today;
          const note = notes.find(
            (n) => n.lineId === f.line.id && ks.includes(n.month - 1),
          );
          const past =
            pct !== null &&
            (p.isZero() ? a.gt(0) : variance.abs().mul(100).gt(p.mul(pct)));
          const reasonMissing = closed && past && !note;
          if (reasonMissing) missing++;
          return {
            period: g + 1,
            from,
            to,
            planned: show(p),
            actual: show(a),
            variance: show(variance),
            variancePct: vp,
            closed,
            reasonMissing,
            reason: note
              ? {
                  reasonCode: note.reasonCode,
                  note: note.note,
                  month: note.month,
                }
              : null,
          };
        });
        return { lineId: f.line.id, category: f.line.category, periods };
      });
      return {
        budgetId: budget.id,
        fiscalYear: budget.fiscalYear,
        by,
        asOf: today,
        varianceReasonPct: pct,
        lines: out,
        missingReasons: missing,
      };
    });
  }

  async periodsCsv(q: {
    budgetId?: string;
    by?: 'month' | 'quarter';
  }): Promise<CsvDownload> {
    const r = await this.periods(q);
    const rows = r.lines.flatMap((l) =>
      l.periods.map((p) => [
        l.category,
        String(p.period),
        p.from,
        p.to,
        p.planned,
        p.actual,
        p.variance,
        p.variancePct ?? '',
        p.reason?.reasonCode ?? '',
        p.reasonMissing ? 'yes' : 'no',
      ]),
    );
    return {
      name: `budget-periods-${r.fiscalYear}-${r.by}.csv`,
      body: toCsv(COLUMNS, rows),
    };
  }
}

/** The first day of each of a fiscal year's twelve months. */
function monthFirsts(startsOn: string): string[] {
  const y = Number(startsOn.slice(0, 4));
  const m = Number(startsOn.slice(5, 7));
  return Array.from({ length: 12 }, (_, k) => {
    const mm = ((m - 1 + k) % 12) + 1;
    const yy = y + Math.floor((m - 1 + k) / 12);
    return `${yy}-${String(mm).padStart(2, '0')}-01`;
  });
}
