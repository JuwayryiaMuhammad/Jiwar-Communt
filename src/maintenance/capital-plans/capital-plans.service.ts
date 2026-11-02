import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type CapitalPlan, type CapitalPlanLine } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { assetNotFound } from '../assets/assets.service';
import { dbNow } from '../db-clock';
import { replacementYear } from '../economics/economics-rules';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { ofDateColumn } from '../schedules/local-dates';

/** How far ahead a plan may be drawn: this year and the next five. */
export const CAPITAL_PLAN_YEARS_AHEAD = 5;

export const capitalPlanNotFound = () =>
  appError.notFound(ErrorCode.CAPITAL_PLAN_NOT_FOUND, 'Capital plan not found');
const lineNotFound = () =>
  appError.notFound(
    ErrorCode.CAPITAL_PLAN_LINE_NOT_FOUND,
    'Capital plan line not found',
  );
const notDraft = (status: string) =>
  appError.conflict(
    ErrorCode.CAPITAL_PLAN_NOT_DRAFT,
    'Only a draft plan is changed or put to the board',
    { params: { status } },
  );

export interface CapitalPlanLineRead {
  id: string;
  assetId: string | null;
  assetCode: string | null;
  assetTypeKey: string | null;
  description: string;
  amount: string;
  source: string;
}

export interface CapitalPlanRecord {
  plan: CapitalPlan;
  total: string;
  lines: CapitalPlanLineRead[];
}

/**
 * A year's capital plan for the board (ADR 0086), with `assets.manage`.
 *
 * - One plan a year (a unique key): drawn for this year or the next five,
 *   seeded on request from the register's computed plan (ADR 0065: each
 *   asset in service with a replacement cost, in its commissioning year
 *   plus its life; one overdue falls in this year).
 * - Lines, while a draft: an asset of the register (once per plan) or the
 *   staff's words alone, and an amount. Under the plan's row lock; a
 *   trigger refuses a line of a plan that is not a draft.
 * - The board: the approval type `capital_plan` names the plan. At the
 *   raise (under governance's locks, then the plan's) a draft with lines
 *   is submitted, its total the cost; approved by the board's motion it is
 *   locked for good (a trigger); rejected or withdrawn, the draft comes
 *   back. Two raises of one plan meet at its lock: the second finds it
 *   submitted (`409 CAPITAL_PLAN_NOT_DRAFT`), and one plan a year makes
 *   one approval a year.
 */
@Injectable()
export class CapitalPlansService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly matters: BoardMatters,
  ) {}

  onModuleInit(): void {
    this.matters.registerApproval('capital_plan', {
      subject: 'capital_plan',
      raise: (tx, ev) => this.submit(tx, ev.requestId, ev.subjectId!),
      describe: async (tx, id) => {
        const plan = id
          ? await tx.capitalPlan.findUnique({ where: { id } })
          : null;
        if (!plan) return null;
        const r = await this.load(tx, plan);
        return {
          capitalPlanId: plan.id,
          year: plan.year,
          status: plan.status,
          total: r.total,
          lines: r.lines.map((l) => ({
            assetCode: l.assetCode,
            assetTypeKey: l.assetTypeKey,
            description: l.description,
            amount: l.amount,
          })),
        };
      },
      decided: (tx, ev) =>
        this.decide(tx, ev.requestId, ev.subjectId!, ev.approved, ev.now),
      withdrawn: async (tx, ev) => {
        await this.giveBack(tx, ev.requestId, ev.subjectId!, 'withdrawn');
      },
    });
  }

  list(): Promise<CapitalPlanRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const plans = await tx.capitalPlan.findMany({
        orderBy: { year: 'desc' },
        take: 50,
      });
      const out: CapitalPlanRecord[] = [];
      for (const p of plans) out.push(await this.load(tx, p));
      return out;
    });
  }

  get(id: string): Promise<CapitalPlanRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const plan = await tx.capitalPlan.findUnique({ where: { id } });
      if (!plan) throw capitalPlanNotFound();
      return this.load(tx, plan);
    });
  }

  create(input: { year: number; seed?: boolean }): Promise<CapitalPlanRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today } = await this.calendar.now(tx);
      const thisYear = Number(today.slice(0, 4));
      if (
        input.year < thisYear ||
        input.year > thisYear + CAPITAL_PLAN_YEARS_AHEAD
      )
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'A plan is for this year or the next five',
          {
            fields: [
              {
                field: 'year',
                code: FieldErrorCode.INVALID_NUMBER,
                params: {
                  min: thisYear,
                  max: thisYear + CAPITAL_PLAN_YEARS_AHEAD,
                },
              },
            ],
          },
        );
      const now = await dbNow(tx);
      const plan = await tx.capitalPlan.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          year: input.year,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      const seeded = input.seed ? await this.seed(tx, plan, thisYear, now) : 0;
      await this.audit.record(tx, {
        action: 'capital_plan.created',
        targetId: plan.id,
        metadata: { year: plan.year, seeded },
      });
      return this.load(tx, plan);
    });
  }

  addLine(
    planId: string,
    input: { assetId?: string; description: string; amount: string },
  ): Promise<CapitalPlanRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const plan = await this.lockDraft(tx, planId);
      if (input.assetId) {
        const asset = await tx.asset.findUnique({
          where: { id: input.assetId },
          select: { id: true },
        });
        if (!asset) throw assetNotFound();
      }
      const line = await tx.capitalPlanLine.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          planId,
          assetId: input.assetId ?? null,
          description: input.description,
          amount: input.amount,
          source: 'manual',
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'capital_plan.line_added',
        targetId: planId,
        metadata: {
          lineId: line.id,
          assetId: line.assetId,
          amount: line.amount.toFixed(2),
        },
      });
      return this.load(tx, plan);
    });
  }

  removeLine(planId: string, lineId: string): Promise<CapitalPlanRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const plan = await this.lockDraft(tx, planId);
      const line = await tx.capitalPlanLine.findFirst({
        where: { id: lineId, planId },
      });
      if (!line) throw lineNotFound();
      await tx.capitalPlanLine.delete({ where: { id: lineId } });
      await this.audit.record(tx, {
        action: 'capital_plan.line_removed',
        targetId: planId,
        metadata: {
          lineId,
          assetId: line.assetId,
          amount: line.amount.toFixed(2),
        },
      });
      return this.load(tx, plan);
    });
  }

  // --------------------------------------------------------------------------

  /** The plan locked for update; a draft, or 409 CAPITAL_PLAN_NOT_DRAFT. */
  private async lockDraft(
    tx: TenantTxClient,
    id: string,
  ): Promise<CapitalPlan> {
    const plan = await this.lock(tx, id);
    if (!plan) throw capitalPlanNotFound();
    if (plan.status !== 'draft') throw notDraft(plan.status);
    return plan;
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<CapitalPlan | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM capital_plans WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) return null;
    return tx.capitalPlan.findUniqueOrThrow({ where: { id } });
  }

  /** The register's replacements due in the plan's year, as its lines. */
  private async seed(
    tx: TenantTxClient,
    plan: CapitalPlan,
    thisYear: number,
    now: Date,
  ): Promise<number> {
    const assets = await tx.asset.findMany({
      where: { status: { not: 'retired' }, replacementCost: { not: null } },
      select: {
        id: true,
        code: true,
        typeId: true,
        commissionedOn: true,
        expectedLifeYears: true,
        replacementCost: true,
      },
      orderBy: { code: 'asc' },
    });
    const lives = new Map(
      (
        await tx.assetType.findMany({
          select: { id: true, expectedLifeYears: true },
        })
      ).map((t) => [t.id, t.expectedLifeYears]),
    );
    const due = assets.filter((a) => {
      const since = a.commissionedOn ? ofDateColumn(a.commissionedOn) : null;
      const year = replacementYear(
        since === null ? null : Number(since.slice(0, 4)),
        a.expectedLifeYears ?? lives.get(a.typeId) ?? null,
      );
      if (year === null) return false;
      return Math.max(year, thisYear) === plan.year;
    });
    if (due.length)
      await tx.capitalPlanLine.createMany({
        data: due.map((a) => ({
          id: newId(),
          tenantId: plan.tenantId,
          planId: plan.id,
          assetId: a.id,
          description: `Replace ${a.code}`,
          amount: a.replacementCost!,
          source: 'computed',
          createdAt: now,
        })),
      });
    return due.length;
  }

  /** At the raise: a draft with lines, now submitted; its total the cost. */
  private async submit(
    tx: TenantTxClient,
    requestId: string,
    planId: string,
  ): Promise<{ cost: string }> {
    const plan = await this.lockDraft(tx, planId);
    const r = await this.load(tx, plan);
    if (!r.lines.length)
      throw appError.conflict(
        ErrorCode.CAPITAL_PLAN_EMPTY,
        'The plan has no line',
      );
    await tx.capitalPlan.update({
      where: { id: planId },
      data: {
        status: 'submitted',
        approvalRequestId: requestId,
        submittedAt: await dbNow(tx),
      },
    });
    await this.audit.record(tx, {
      action: 'capital_plan.submitted',
      targetId: planId,
      metadata: { requestId, year: plan.year, total: r.total },
    });
    return { cost: r.total };
  }

  /**
   * At the board's decision: approved, the plan is locked for good;
   * rejected, the draft comes back. Never throws for the plan's state.
   */
  private async decide(
    tx: TenantTxClient,
    requestId: string,
    planId: string,
    approved: boolean,
    now: Date,
  ): Promise<{ implemented: boolean }> {
    if (!approved) {
      await this.giveBack(tx, requestId, planId, 'rejected');
      return { implemented: false };
    }
    const plan = await this.lock(tx, planId);
    if (
      !plan ||
      plan.status !== 'submitted' ||
      plan.approvalRequestId !== requestId
    )
      return { implemented: false };
    await tx.capitalPlan.update({
      where: { id: planId },
      data: { status: 'approved', approvedAt: now },
    });
    await this.audit.record(tx, {
      action: 'capital_plan.decided',
      targetId: planId,
      metadata: { requestId, year: plan.year, status: 'approved' },
    });
    return { implemented: true };
  }

  /** A rejected or withdrawn request gives the draft back, if it still names it. */
  private async giveBack(
    tx: TenantTxClient,
    requestId: string,
    planId: string,
    why: 'rejected' | 'withdrawn',
  ): Promise<void> {
    const plan = await this.lock(tx, planId);
    if (
      !plan ||
      plan.status !== 'submitted' ||
      plan.approvalRequestId !== requestId
    )
      return;
    await tx.capitalPlan.update({
      where: { id: planId },
      data: { status: 'draft', approvalRequestId: null, submittedAt: null },
    });
    await this.audit.record(tx, {
      action: 'capital_plan.returned',
      targetId: planId,
      metadata: { requestId, year: plan.year, reasonCode: why },
    });
  }

  private async load(
    tx: TenantTxClient,
    plan: CapitalPlan,
  ): Promise<CapitalPlanRecord> {
    const lines: CapitalPlanLine[] = await tx.capitalPlanLine.findMany({
      where: { planId: plan.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ids = lines.flatMap((l) => (l.assetId ? [l.assetId] : []));
    const assets = new Map(
      (
        await tx.asset.findMany({
          where: { id: { in: ids } },
          select: { id: true, code: true, typeId: true },
        })
      ).map((a) => [a.id, a]),
    );
    const types = new Map(
      (
        await tx.assetType.findMany({
          where: { id: { in: [...assets.values()].map((a) => a.typeId) } },
          select: { id: true, key: true },
        })
      ).map((t) => [t.id, t.key]),
    );
    const total = lines.reduce(
      (s, l) => s.plus(l.amount),
      new Prisma.Decimal(0),
    );
    return {
      plan,
      total: total.toFixed(2),
      lines: lines.map((l) => {
        const a = l.assetId ? assets.get(l.assetId) : undefined;
        return {
          id: l.id,
          assetId: l.assetId,
          assetCode: a?.code ?? null,
          assetTypeKey: a ? (types.get(a.typeId) ?? null) : null,
          description: l.description,
          amount: l.amount.toFixed(2),
          source: l.source,
        };
      }),
    };
  }
}
