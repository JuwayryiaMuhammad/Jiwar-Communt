import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { BillingPlan, BillingPlanOverride } from '@prisma/client';
import { CommunityFinancePort, type FinanceUnit } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
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
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(BILLING_PLAN_RESOURCE, (id) => this.get(id));
    this.sweep.register(BILLING_SWEEP, () => this.run());
  }

  create(dto: CreateBillingPlanDto): Promise<BillingPlanView> {
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

  /** Names, amount, days, active: for periods issued afterwards. */
  update(id: string, dto: UpdateBillingPlanDto): Promise<BillingPlanView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM billing_plans WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw planNotFound();
      const before = await tx.billingPlan.findUniqueOrThrow({ where: { id } });
      const after = await tx.billingPlan.update({
        where: { id },
        data: {
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          amount: dto.amount === undefined ? undefined : money(dto.amount),
          issueDaysBefore: dto.issueDaysBefore,
          dueDaysAfterIssue: dto.dueDaysAfterIssue,
          active: dto.active,
        },
      });
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
function nextPeriod(plan: BillingPlan, today: LocalDate): Period {
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
  };
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
