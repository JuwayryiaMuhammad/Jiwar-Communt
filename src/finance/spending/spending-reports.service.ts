import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { BUDGET_CATEGORIES, fiscalYearOf } from '../budgets/budget-rules';
import { BudgetsService, budgetNotFound } from '../budgets/budgets.service';
import { asDate, fromDate, localToday } from '../db-clock';
import { show } from '../money';

export const SPENDING_REPORT_RESOURCE = 'spending_report';
/** The most improvements a report names. */
export const SPENDING_REPORT_ITEMS = 20;

export interface SpendingReportInput {
  budgetId?: string;
  summaryEn?: string;
  summaryAr?: string;
  items?: { textEn: string; textAr: string; decisionPublicationId?: string }[];
}

export interface SpendingReport {
  id: string;
  fiscalYear: number;
  startsOn: string;
  asOf: string;
  summaryEn: string | null;
  summaryAr: string | null;
  publishedAt: Date;
  lines: {
    category: string;
    allowance: string;
    spent: string;
    usedPct: string;
  }[];
  totals: { allowance: string; spent: string; usedPct: string };
  items: {
    position: number;
    textEn: string;
    textAr: string;
    decision: { publicationId: string; decidedOn: string | null } | null;
  }[];
}

const notFound = () =>
  appError.notFound(
    ErrorCode.SPENDING_REPORT_NOT_FOUND,
    'Spending report not found',
  );

const CATEGORY_ORDER = (c: string) =>
  (BUDGET_CATEGORIES as readonly string[]).indexOf(c);

const pct = (part: Prisma.Decimal, whole: Prisma.Decimal) =>
  whole.isZero() ? '0.0' : part.mul(100).div(whole).toFixed(1);

/**
 * Where the fees go (ADR 0069). The finance staff publish, in one act, a
 * snapshot of an active budget as of the compound's today: each
 * category's allowance and what was spent, never an expense, a vendor or a
 * name, and the improvements it paid for in their words, each may cite
 * the board's published decision. Everyone who sees a unit's money reads
 * it — tenants as well as owners — and is told. One snapshot of a budget
 * a day; a report never changes after.
 */
@Injectable()
export class SpendingReportsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly settings: TenantSettingsService,
    private readonly access: FinanceAccess,
    private readonly budgets: BudgetsService,
    private readonly matters: BoardMatters,
    private readonly community: CommunityFinancePort,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(SPENDING_REPORT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) => this.load(tx, id)),
    );
  }

  publish(input: SpendingReportInput): Promise<SpendingReport> {
    if ((input.summaryEn === undefined) !== (input.summaryAr === undefined))
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid request',
        {
          fields: [
            {
              field: input.summaryEn === undefined ? 'summaryEn' : 'summaryAr',
              code: FieldErrorCode.FIELD_REQUIRED,
            },
          ],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: SPENDING_REPORT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = await localToday(tx, timezone);
      const budget = input.budgetId
        ? await tx.financeBudget.findUnique({ where: { id: input.budgetId } })
        : await tx.financeBudget.findFirst({
            where: {
              status: 'active',
              fiscalYear: fiscalYearOf(
                today,
                (
                  await tx.financeSettings.findUniqueOrThrow({
                    where: { tenantId: this.ctx.txTenantId },
                  })
                ).fiscalYearStartMonth,
              ),
            },
          });
      if (!budget) throw budgetNotFound();
      if (budget.status !== 'active')
        throw appError.conflict(
          ErrorCode.BUDGET_NOT_ACTIVE,
          'Only an approved budget is reported',
          { params: { status: budget.status } },
        );
      const startsOn = fromDate(budget.startsOn);
      const endsOn = fromDate(budget.endsOn);
      if (today < startsOn)
        throw appError.conflict(
          ErrorCode.BUDGET_NOT_ACTIVE,
          'The budget’s year has not started',
          { params: { status: budget.status } },
        );
      // A year that ended is reported as it closed.
      const asOf = today > endsOn ? endsOn : today;
      const items = input.items ?? [];
      for (const item of items)
        if (
          item.decisionPublicationId &&
          !(await this.matters.publishedDecision(
            tx,
            item.decisionPublicationId,
          ))
        )
          throw appError.notFound(
            ErrorCode.BOARD_PUBLICATION_NOT_FOUND,
            'No published board decision has this id',
          );
      const same = await tx.financeSpendingReport.findUnique({
        where: {
          tenantId_budgetId_asOf: {
            tenantId: this.ctx.txTenantId,
            budgetId: budget.id,
            asOf: asDate(asOf),
          },
        },
        select: { id: true },
      });
      if (same) throw exists(same.id);
      const record = await this.budgets.load(tx, budget);
      try {
        await tx.financeSpendingReport.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            budgetId: budget.id,
            fiscalYear: budget.fiscalYear,
            startsOn: budget.startsOn,
            asOf: asDate(asOf),
            summaryEn: input.summaryEn ?? null,
            summaryAr: input.summaryAr ?? null,
            publishedBy: this.ctx.accountId,
            lines: {
              // The compound comes from the report: a nested row names none.
              create: record.lines.map((l) => ({
                category: l.line.category,
                allowance: l.allowance,
                spent: l.spent,
              })),
            },
            items: {
              create: items.map((item, i) => ({
                id: newId(),
                position: i + 1,
                decisionPublicationId: item.decisionPublicationId ?? null,
                textEn: item.textEn,
                textAr: item.textAr,
              })),
            },
          },
        });
      } catch (e) {
        // A publication of the same budget and day committed first.
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        )
          throw exists(null);
        throw e;
      }
      await this.audit.record(tx, {
        action: 'spending_report.published',
        targetId: id,
        metadata: {
          budgetId: budget.id,
          fiscalYear: budget.fiscalYear,
          asOf,
          items: items.length,
        },
      });
      await this.notifier.notify(tx, await this.community.financeReaders(tx), {
        kind: 'finance.spending_report_published',
        params: { fiscalYear: String(budget.fiscalYear), asOf },
        targetId: id,
      });
      return this.load(tx, id);
    });
  }

  /** Newest first: the staff's list, and the readers'. */
  list(): Promise<SpendingReport[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.financeSpendingReport.findMany({
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { id: true },
      });
      const out: SpendingReport[] = [];
      for (const r of rows) out.push(await this.load(tx, r.id));
      return out;
    });
  }

  get(id: string): Promise<SpendingReport> {
    return this.tenantTx.withTenantTx((tx) => this.load(tx, id));
  }

  /** For whoever sees some unit's money now; anyone else is refused. */
  async assertReader(): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      if (!(await this.community.financeUnits(tx, this.ctx.accountId)).length)
        throw appError.forbidden(ErrorCode.FORBIDDEN, 'Not allowed');
    });
  }

  private async load(tx: TenantTxClient, id: string): Promise<SpendingReport> {
    const r = await tx.financeSpendingReport.findUnique({
      where: { id },
      include: {
        lines: true,
        items: { orderBy: { position: 'asc' } },
      },
    });
    if (!r) throw notFound();
    const allowance = r.lines.reduce(
      (n, l) => n.plus(l.allowance),
      new Prisma.Decimal(0),
    );
    const spent = r.lines.reduce(
      (n, l) => n.plus(l.spent),
      new Prisma.Decimal(0),
    );
    const items: SpendingReport['items'] = [];
    for (const i of r.items)
      items.push({
        position: i.position,
        textEn: i.textEn,
        textAr: i.textAr,
        decision: i.decisionPublicationId
          ? {
              publicationId: i.decisionPublicationId,
              decidedOn:
                (
                  await this.matters.publishedDecision(
                    tx,
                    i.decisionPublicationId,
                  )
                )?.decidedOn ?? null,
            }
          : null,
      });
    return {
      id: r.id,
      fiscalYear: r.fiscalYear,
      startsOn: fromDate(r.startsOn),
      asOf: fromDate(r.asOf),
      summaryEn: r.summaryEn,
      summaryAr: r.summaryAr,
      publishedAt: r.publishedAt,
      lines: r.lines
        .sort((a, b) => CATEGORY_ORDER(a.category) - CATEGORY_ORDER(b.category))
        .map((l) => ({
          category: l.category,
          allowance: show(l.allowance),
          spent: show(l.spent),
          usedPct: pct(l.spent, l.allowance),
        })),
      totals: {
        allowance: show(allowance),
        spent: show(spent),
        usedPct: pct(spent, allowance),
      },
      items,
    };
  }
}

const exists = (reportId: string | null) =>
  appError.conflict(
    ErrorCode.SPENDING_REPORT_EXISTS,
    'The budget has a report of this day already',
    reportId ? { params: { reportId } } : {},
  );
