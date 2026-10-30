import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BillingPlan, BillingPlanOverride } from '@prisma/client';
import { CommunityFinancePort, type FinanceUnit } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { addDays, type LocalDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { asDate, fromDate, localToday } from '../db-clock';
import { InvoicesService, MAX_BATCH_UNITS } from '../invoices/invoices.service';
import { money, show } from '../money';
import type {
  CreateBillingPlanDto,
  SetBillingOverrideDto,
  UpdateBillingPlanDto,
} from './dto/billing-plans.dto';
import {
  addMonths,
  periodHolding,
  periodLabel,
  periodsToBill,
  type Period,
  type PlanTerms,
} from './periods';
import type {
  BillingAmountChangeView,
  BillingOverrideView,
  BillingPlanView,
} from './views/billing-plan.views';

export const BILLING_PLAN_RESOURCE = 'billing_plan';
export const BILLING_SWEEP = 'finance.billing';

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

const planNotFound = () =>
  appError.notFound(ErrorCode.BILLING_PLAN_NOT_FOUND, 'Billing plan not found');

const MONTHS = { monthly: 1, quarterly: 3, annual: 12 } as const;

/**
 * Recurring billing (ADR 0046): a plan bills every unit a fixed amount each
 * period, with per-unit overrides. The sweep issues each period's invoices
 * under the compound's exclusive finance lock, so it decides alone which
 * units are missing; a unique index keeps one invoice per (plan, unit,
 * period) whatever else happens.
 */
@Injectable()
export class BillingPlansService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
    private readonly tenantSettings: TenantSettingsService,
    private readonly community: CommunityFinancePort,
    private readonly access: FinanceAccess,
    private readonly invoices: InvoicesService,
    private readonly matters: BoardMatters,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(BILLING_PLAN_RESOURCE, (id) => this.get(id));
    this.sweep.register(BILLING_SWEEP, () => this.run());
  }

  create(dto: CreateBillingPlanDto): Promise<BillingPlanView> {
    const description = bothOrNeither(
      dto.descriptionEn ?? null,
      dto.descriptionAr ?? null,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: BILLING_PLAN_RESOURCE, id });
      await this.access.lockSelf(tx);
      const today = await this.today(tx);
      const min = `${today.slice(0, 8)}01`;
      const max = addDays(today, 366);
      if (dto.startsOn < min || dto.startsOn > max)
        throw invalid([
          {
            field: 'startsOn',
            code: FieldErrorCode.STARTS_ON_OUT_OF_RANGE,
            params: { min, max },
          },
        ]);
      const plan = await tx.billingPlan.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          kind: dto.kind,
          frequency: dto.frequency,
          amount: money(dto.amount),
          startsOn: asDate(dto.startsOn),
          issueDaysBefore: dto.issueDaysBefore,
          dueDaysAfterIssue: dto.dueDaysAfterIssue,
          createdById: this.ctx.accountId,
          descriptionEn: description.en,
          descriptionAr: description.ar,
        },
      });
      await this.audit.record(tx, {
        action: 'billing_plan.created',
        targetId: id,
        changes: diffChanges(null, auditable(plan), 'billing_plan.created'),
      });
      return planView(plan, 0, today);
    });
  }

  /**
   * Names, amount, days, active, what it pays for: for periods issued
   * afterwards. A new amount is kept as a change (ADR 0069) — from, to,
   * the first period billed at it, and the board's decision when one set
   * it — decided under the compound's exclusive finance lock, which the
   * billing sweep holds too, so a change and a period's issue never cross.
   */
  update(id: string, dto: UpdateBillingPlanDto): Promise<BillingPlanView> {
    if (dto.decisionPublicationId !== undefined && dto.amount === undefined)
      throw invalid([
        {
          field: 'decisionPublicationId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (dto.amount !== undefined) await this.access.lockCompound(tx);
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM billing_plans WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw planNotFound();
      const before = await tx.billingPlan.findUniqueOrThrow({ where: { id } });
      const description = bothOrNeither(
        dto.descriptionEn === undefined
          ? before.descriptionEn
          : dto.descriptionEn,
        dto.descriptionAr === undefined
          ? before.descriptionAr
          : dto.descriptionAr,
      );
      const amount =
        dto.amount === undefined ? before.amount : money(dto.amount);
      const amountChanged = !amount.equals(before.amount);
      if (dto.decisionPublicationId !== undefined && !amountChanged)
        throw invalid([
          {
            field: 'decisionPublicationId',
            code: FieldErrorCode.FIELD_NOT_ALLOWED,
          },
        ]);
      if (
        dto.decisionPublicationId !== undefined &&
        !(await this.matters.publishedDecision(tx, dto.decisionPublicationId))
      )
        throw appError.notFound(
          ErrorCode.BOARD_PUBLICATION_NOT_FOUND,
          'No published board decision has this id',
        );
      const after = await tx.billingPlan.update({
        where: { id },
        data: {
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          amount,
          issueDaysBefore: dto.issueDaysBefore,
          dueDaysAfterIssue: dto.dueDaysAfterIssue,
          active: dto.active,
          descriptionEn: description.en,
          descriptionAr: description.ar,
        },
      });
      let effectiveOn: LocalDate | null = null;
      if (amountChanged) {
        // The first period not yet issued: the end of the latest issued.
        const latest = await tx.invoice.findFirst({
          where: { planId: id, periodEndsOn: { not: null } },
          orderBy: { periodStartsOn: 'desc' },
          select: { periodEndsOn: true },
        });
        effectiveOn = latest
          ? fromDate(latest.periodEndsOn!)
          : fromDate(before.startsOn);
        await tx.billingPlanAmountChange.create({
          data: {
            id: newId(),
            tenantId: this.ctx.txTenantId,
            planId: id,
            fromAmount: before.amount,
            toAmount: amount,
            effectiveOn: asDate(effectiveOn),
            decisionPublicationId: dto.decisionPublicationId ?? null,
            changedById: this.ctx.accountId,
          },
        });
      }
      const changes = diffChanges(
        auditable(before),
        auditable(after),
        'billing_plan.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'billing_plan.updated',
          targetId: id,
          changes,
          ...(effectiveOn
            ? {
                metadata: {
                  effectiveOn,
                  decisionPublicationId: dto.decisionPublicationId ?? null,
                },
              }
            : {}),
        });
      return planView(
        after,
        await this.overrideCount(tx, id),
        await this.today(tx),
      );
    });
  }

  list(): Promise<BillingPlanView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const plans = await tx.billingPlan.findMany({
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      });
      const counts = await tx.billingPlanOverride.groupBy({
        by: ['planId'],
        _count: { _all: true },
      });
      const today = await this.today(tx);
      return plans.map((p) =>
        planView(
          p,
          counts.find((c) => c.planId === p.id)?._count._all ?? 0,
          today,
        ),
      );
    });
  }

  get(id: string): Promise<BillingPlanView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const plan = await tx.billingPlan.findUnique({ where: { id } });
      if (!plan) throw planNotFound();
      return planView(
        plan,
        await this.overrideCount(tx, id),
        await this.today(tx),
      );
    });
  }

  /** A plan's amount changes, the latest first (ADR 0069). */
  amountChanges(planId: string): Promise<BillingAmountChangeView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.billingPlan.findUnique({ where: { id: planId } })))
        throw planNotFound();
      const rows = await tx.billingPlanAmountChange.findMany({
        where: { planId },
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map((r) => ({
        id: r.id,
        fromAmount: show(r.fromAmount),
        toAmount: show(r.toAmount),
        effectiveOn: fromDate(r.effectiveOn),
        decisionPublicationId: r.decisionPublicationId,
        changedAt: r.changedAt,
      }));
    });
  }

  overrides(planId: string): Promise<BillingOverrideView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.billingPlan.findUnique({ where: { id: planId } })))
        throw planNotFound();
      const rows = await tx.billingPlanOverride.findMany({
        where: { planId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const units = await this.community.units(
        tx,
        rows.map((r) => r.unitId),
      );
      return rows.map((r) => overrideView(r, units.get(r.unitId)));
    });
  }

  /** Another amount for the unit, or none at all: exactly one. */
  setOverride(
    planId: string,
    unitId: string,
    dto: SetBillingOverrideDto,
  ): Promise<BillingOverrideView> {
    const excluded = dto.excluded === true;
    const hasAmount = dto.amount !== undefined;
    if (hasAmount === excluded)
      throw invalid(
        hasAmount
          ? [{ field: 'excluded', code: FieldErrorCode.FIELD_NOT_ALLOWED }]
          : [{ field: 'amount', code: FieldErrorCode.FIELD_REQUIRED }],
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (!(await tx.billingPlan.findUnique({ where: { id: planId } })))
        throw planNotFound();
      const unit = (await this.community.units(tx, [unitId])).get(unitId);
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const before = await tx.billingPlanOverride.findUnique({
        where: {
          tenantId_planId_unitId: {
            tenantId: this.ctx.txTenantId,
            planId,
            unitId,
          },
        },
      });
      const amount = excluded ? null : money(dto.amount!);
      const row = await tx.billingPlanOverride.upsert({
        where: {
          tenantId_planId_unitId: {
            tenantId: this.ctx.txTenantId,
            planId,
            unitId,
          },
        },
        create: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          planId,
          unitId,
          amount,
          excluded,
          updatedById: this.ctx.accountId,
        },
        update: { amount, excluded, updatedById: this.ctx.accountId },
      });
      await this.audit.record(tx, {
        action: 'billing_plan.override_set',
        targetId: planId,
        metadata: {
          unitId,
          amount: amount ? show(amount) : null,
          excluded,
          ...(before
            ? {
                previousAmount: before.amount ? show(before.amount) : null,
                previousExcluded: before.excluded,
              }
            : {}),
        },
      });
      return overrideView(row, unit);
    });
  }

  removeOverride(planId: string, unitId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (!(await tx.billingPlan.findUnique({ where: { id: planId } })))
        throw planNotFound();
      const { count } = await tx.billingPlanOverride.deleteMany({
        where: { planId, unitId },
      });
      if (!count)
        throw appError.notFound(
          ErrorCode.BILLING_OVERRIDE_NOT_FOUND,
          'No terms of its own',
        );
      await this.audit.record(tx, {
        action: 'billing_plan.override_removed',
        targetId: planId,
        metadata: { unitId },
      });
    });
  }

  // --------------------------------------------------------------------------
  // The sweep
  // --------------------------------------------------------------------------

  /** Invoices issued, every active plan of every active compound. */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true },
        });
        if (tenant?.status !== 'active') return [];
        const plans = await tx.billingPlan.findMany({
          where: { active: true },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        return plans.map((p) => p.id);
      },
      (tx, _tenantId, planId) => this.billPlan(tx, planId),
    );
  }

  /**
   * One plan's due periods, in one transaction under the compound's
   * exclusive lock: the units not yet billed for a period (and not
   * excluded) get an invoice each, one batch per amount.
   */
  async billPlan(tx: TenantTxClient, planId: string): Promise<number> {
    await this.access.lockCompound(tx);
    const plan = await tx.billingPlan.findUnique({ where: { id: planId } });
    if (!plan?.active) return 0;
    const today = await this.today(tx);
    let issued = 0;
    for (const period of periodsToBill(terms(plan), today)) {
      const units = await this.community.unitsFor(tx, 'all');
      const overrides = new Map(
        (await tx.billingPlanOverride.findMany({ where: { planId } })).map(
          (o) => [o.unitId, o],
        ),
      );
      const billed = new Set(
        (
          await tx.invoice.findMany({
            where: { planId, periodStartsOn: asDate(period.start) },
            select: { unitId: true },
          })
        ).map((i) => i.unitId),
      );
      const byAmount = new Map<string, FinanceUnit[]>();
      for (const u of units) {
        if (billed.has(u.id)) continue;
        const o = overrides.get(u.id);
        if (o?.excluded) continue;
        const amount = show(o?.amount ?? plan.amount);
        byAmount.set(amount, [...(byAmount.get(amount) ?? []), u]);
      }
      for (const [amount, group] of byAmount) {
        for (let i = 0; i < group.length; i += MAX_BATCH_UNITS) {
          const chunk = group.slice(i, i + MAX_BATCH_UNITS);
          await this.invoices.issueTo(tx, {
            batchId: newId(),
            target: 'all',
            units: chunk,
            kind: plan.kind,
            issuedOn: today,
            dueOn: addDays(today, plan.dueDaysAfterIssue),
            lines: [
              {
                descriptionEn: `${plan.nameEn} — ${periodLabel(period)}`,
                descriptionAr: `${plan.nameAr} — ${periodLabel(period)}`,
                amount: money(amount),
              },
            ],
            createdById: null,
            plan: { id: plan.id, period },
          });
          issued += chunk.length;
        }
      }
    }
    return issued;
  }

  private overrideCount(tx: TenantTxClient, planId: string): Promise<number> {
    return tx.billingPlanOverride.count({ where: { planId } });
  }

  private async today(tx: TenantTxClient): Promise<LocalDate> {
    const settings = await this.tenantSettings.inTx(tx, this.ctx.txTenantId);
    return localToday(tx, settings.timezone);
  }
}

function terms(plan: BillingPlan): PlanTerms {
  return {
    frequency: plan.frequency,
    startsOn: fromDate(plan.startsOn),
    issueDaysBefore: plan.issueDaysBefore,
  };
}

/** The next period to issue after today's. */
export function nextPeriod(plan: BillingPlan, today: LocalDate): Period {
  const t = terms(plan);
  const current = periodHolding(t, today);
  const start = current ? current.end : t.startsOn;
  return { start, end: addMonths(start, MONTHS[plan.frequency]) };
}

function auditable(p: BillingPlan) {
  return {
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    kind: p.kind,
    frequency: p.frequency,
    amount: show(p.amount),
    startsOn: fromDate(p.startsOn),
    issueDaysBefore: p.issueDaysBefore,
    dueDaysAfterIssue: p.dueDaysAfterIssue,
    active: p.active,
    descriptionEn: p.descriptionEn,
    descriptionAr: p.descriptionAr,
  };
}

/** A fee's description: both languages or neither (ADR 0069). */
function bothOrNeither(
  en: string | null,
  ar: string | null,
): { en: string | null; ar: string | null } {
  if ((en === null) !== (ar === null))
    throw invalid([
      {
        field: en === null ? 'descriptionEn' : 'descriptionAr',
        code: FieldErrorCode.FIELD_REQUIRED,
      },
    ]);
  return { en, ar };
}

function planView(
  p: BillingPlan,
  overrideCount: number,
  today: LocalDate,
): BillingPlanView {
  const next = p.active ? nextPeriod(p, today) : null;
  return {
    id: p.id,
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    kind: p.kind,
    frequency: p.frequency,
    amount: show(p.amount),
    startsOn: fromDate(p.startsOn),
    issueDaysBefore: p.issueDaysBefore,
    dueDaysAfterIssue: p.dueDaysAfterIssue,
    active: p.active,
    descriptionEn: p.descriptionEn,
    descriptionAr: p.descriptionAr,
    overrideCount,
    nextPeriod: next
      ? {
          startsOn: next.start,
          endsOn: next.end,
          issueOn: addDays(next.start, -p.issueDaysBefore),
        }
      : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function overrideView(
  o: BillingPlanOverride,
  unit: FinanceUnit | undefined,
): BillingOverrideView {
  return {
    unitId: o.unitId,
    unitCode: unit?.code ?? '',
    amount: o.amount ? show(o.amount) : null,
    excluded: o.excluded,
    updatedAt: o.updatedAt,
  };
}
