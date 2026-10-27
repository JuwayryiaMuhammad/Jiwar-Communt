import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  AssetReading,
  MaintenancePlan,
  MaintenancePlanEvent,
  MaintenancePlanOccurrence,
  Ticket,
  TicketPriority,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { AssetsService } from '../assets/assets.service';
import { AssetReadings } from '../checklists/asset-readings.service';
import { ChecklistRuns } from '../checklists/checklist-runs';
import { ChecklistsService } from '../checklists/checklists.service';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  addDays,
  dateColumn,
  isRealDate,
  ofDateColumn,
  ofDateColumnOrNull,
  type LocalDate,
} from '../schedules/local-dates';
import type { RecurrenceUnit } from '../schedules/recurrence';
import { ConfirmationService } from '../tickets/confirmation.service';
import { TicketAccess } from '../tickets/ticket-access';
import { TicketsService } from '../tickets/tickets.service';
import { WorkService } from '../tickets/work.service';
import {
  afterDone,
  afterGeneration,
  firstDue,
  MAX_DEFER_DAYS,
  onTime,
  opensBy,
  usageDue,
  type CalendarSeries,
  type PlanBasis,
  type PlanTrigger,
} from './plan-rules';

export const PLAN_RESOURCE = 'maintenance_plan';

export interface PlanInput {
  assetId: string;
  checklistId?: string;
  title: string;
  categoryId?: string;
  priority?: TicketPriority;
  trigger: PlanTrigger;
  every?: number;
  unit?: RecurrenceUnit;
  anchorOn?: LocalDate;
  basis?: PlanBasis;
  metricKey?: string;
  usageInterval?: string;
  leadDays?: number;
  graceDays?: number;
  ownerId?: string;
}

export interface PlanUpdate {
  title?: string;
  checklistId?: string | null;
  categoryId?: string;
  priority?: TicketPriority;
  every?: number;
  unit?: RecurrenceUnit;
  anchorOn?: LocalDate;
  basis?: PlanBasis;
  usageInterval?: string;
  leadDays?: number;
  graceDays?: number;
  ownerId?: string;
}

export interface PlanQuery {
  assetId?: string;
  active?: 'true' | 'false';
  cursor?: string;
  limit?: number;
}

export interface PlanRead {
  plan: MaintenancePlan;
  /** Occurrences done on time, done, and open past their grace. */
  stats: { done: number; onTime: number; overdue: number; open: number };
}

const PAGE = keysetCursor('createdAt', 'desc');
const EVENTS = keysetCursor('occurredAt', 'desc');
const OCCURRENCES = keysetCursor('generatedAt', 'desc');

export const planNotFound = () =>
  appError.notFound(ErrorCode.MAINTENANCE_PLAN_NOT_FOUND, 'Plan not found');
const occurrenceNotFound = () =>
  appError.notFound(
    ErrorCode.PLAN_OCCURRENCE_NOT_FOUND,
    'Occurrence not found',
  );
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid plan', { fields });

/**
 * An asset's planned work (ADR 0064). A calendar plan comes due on its
 * series (fixed, or floating from the day the last was done), a usage plan
 * when a metric's readings grew by its interval. Each due date opens one
 * occurrence and its work order (the plan's category, its checklist, its
 * owner as the reporter) `lead_days` before; the technician's completion
 * marks it done, on time or not; past its grace, the owner and dispatch
 * are told once. A due date may be deferred or skipped with a reason.
 * Kept with `assets.manage`, read with `assets.read`.
 *
 * Lock order, everywhere: accounts (shared: the caller, the owner), the
 * asset (shared), the plan (for update), its occurrence; a ticket, when a
 * hook runs under it, before all of them. Days are the compound's; times
 * the database's. Opening an occurrence is once per plan and original due
 * date (a unique index backs the plan's lock).
 */
@Injectable()
export class PlansService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly assets: AssetsService,
    private readonly checklists: ChecklistsService,
    private readonly runs: ChecklistRuns,
    private readonly readings: AssetReadings,
    private readonly tickets: TicketsService,
    private readonly work: WorkService,
    private readonly confirmation: ConfirmationService,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(PLAN_RESOURCE, (id) => this.get(id));
    this.work.onCompleting((tx, ticket) => this.completing(tx, ticket));
    this.confirmation.onCancelling((tx, ticket) => this.cancelling(tx, ticket));
    this.readings.onRecorded((tx, rows) => this.usage(tx, rows));
    this.assets.onRetired(async (tx, asset) => {
      const plans = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM maintenance_plans
         WHERE asset_id = ${asset.id}::uuid AND active ORDER BY id FOR UPDATE`;
      for (const { id } of plans) {
        await tx.maintenancePlan.update({
          where: { id },
          data: { active: false },
        });
        await this.event(tx, asset.tenantId, id, null, 'deactivated', {
          reason: 'asset_retired',
        });
      }
    });
  }

  list(q: PlanQuery): Promise<Page<MaintenancePlan>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.maintenancePlan.findMany({
        where: {
          AND: [
            q.assetId ? { assetId: q.assetId } : {},
            q.active ? { active: q.active === 'true' } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<PlanRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.read(tx, await this.find(tx, id)),
    );
  }

  occurrences(
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<MaintenancePlanOccurrence>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.find(tx, id);
      const rows = await tx.maintenancePlanOccurrence.findMany({
        where: { AND: [{ planId: id }, ...OCCURRENCES.after(q.cursor)] },
        orderBy: OCCURRENCES.orderBy,
        take: limit + 1,
      });
      return OCCURRENCES.toPage(rows, limit);
    });
  }

  events(
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<MaintenancePlanEvent>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.find(tx, id);
      const rows = await tx.maintenancePlanEvent.findMany({
        where: { AND: [{ planId: id }, ...EVENTS.after(q.cursor)] },
        orderBy: EVENTS.orderBy,
        take: limit + 1,
      });
      return EVENTS.toPage(rows, limit);
    });
  }

  create(input: PlanInput): Promise<PlanRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: PLAN_RESOURCE, id });
      await this.access.lockSelf(tx);
      const ownerId = input.ownerId ?? this.ctx.accountId;
      await this.requireOwner(tx, ownerId);
      const asset = await this.assets.requireActive(tx, input.assetId);
      if (asset.unitId !== null)
        throw appError.conflict(
          ErrorCode.PLAN_FOR_UNIT_ASSET,
          'An asset in a unit takes no plan: its household books the check-ups',
        );
      const categoryId =
        input.categoryId ??
        (await tx.assetType.findUniqueOrThrow({ where: { id: asset.typeId } }))
          .categoryId;
      await this.requireCategory(
        tx,
        categoryId,
        input.categoryId !== undefined,
      );
      if (input.checklistId !== undefined)
        await this.checklists.requireUsable(tx, input.checklistId, 'pm');
      const fields = shapeProblems(input);
      if (fields.length) throw invalid(fields);
      const { today } = await this.calendar.now(tx);
      const series = input.trigger === 'calendar' ? seriesOf(input) : null;
      const last =
        input.trigger === 'usage'
          ? await this.lastValue(tx, input.assetId, input.metricKey!)
          : null;
      const plan = await tx.maintenancePlan.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          assetId: asset.id,
          checklistId: input.checklistId ?? null,
          title: input.title.trim(),
          categoryId,
          priority: input.priority ?? 'normal',
          trigger: input.trigger,
          ...(series
            ? {
                every: series.every,
                unit: series.unit,
                anchorOn: dateColumn(series.anchorOn),
                basis: series.basis,
                nextDueOn: dateColumn(firstDue(series, today)),
              }
            : {
                metricKey: input.metricKey!,
                usageInterval: input.usageInterval!,
                usageLastValue: last,
              }),
          leadDays: input.leadDays ?? 7,
          graceDays: input.graceDays ?? 3,
          ownerId,
        },
      });
      await this.event(tx, plan.tenantId, id, null, 'created', {
        to: ofDateColumnOrNull(plan.nextDueOn),
      });
      await this.audit.record(tx, {
        action: 'maintenance_plan.created',
        targetId: id,
        changes: diffChanges(null, audited(plan), 'maintenance_plan.created'),
      });
      return this.read(tx, plan);
    });
  }

  /**
   * A new series re-times the next due date from today (not while a
   * floating plan's occurrence is open: it is timed when that one ends).
   */
  update(id: string, input: PlanUpdate): Promise<PlanRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (input.ownerId !== undefined)
        await this.requireOwner(tx, input.ownerId);
      const plan = await this.findForWrite(tx, id);
      const fields: FieldError[] = [];
      const timing = ['every', 'unit', 'anchorOn', 'basis'] as const;
      if (plan.trigger === 'usage')
        for (const f of timing)
          if (input[f] !== undefined)
            fields.push({ field: f, code: FieldErrorCode.FIELD_NOT_ALLOWED });
      if (plan.trigger === 'calendar' && input.usageInterval !== undefined)
        fields.push({
          field: 'usageInterval',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      if (input.anchorOn !== undefined && !isRealDate(input.anchorOn))
        fields.push({ field: 'anchorOn', code: FieldErrorCode.INVALID_FORMAT });
      if (fields.length) throw invalid(fields);
      if (input.categoryId !== undefined)
        await this.requireCategory(tx, input.categoryId, true);
      if (input.checklistId)
        await this.checklists.requireUsable(tx, input.checklistId, 'pm');
      let nextDueOn: Date | null | undefined;
      if (
        plan.trigger === 'calendar' &&
        timing.some((f) => input[f] !== undefined)
      ) {
        const series = seriesOf({
          ...seriesOfPlan(plan),
          ...definedOf(input, timing),
        });
        const open = await this.openOccurrence(tx, id);
        const { today } = await this.calendar.now(tx);
        nextDueOn =
          series.basis === 'floating' && open
            ? null
            : dateColumn(firstDue(series, today));
      }
      const updated = await tx.maintenancePlan.update({
        where: { id },
        data: {
          title: input.title?.trim(),
          checklistId: input.checklistId,
          categoryId: input.categoryId,
          priority: input.priority,
          every: input.every,
          unit: input.unit,
          anchorOn:
            input.anchorOn === undefined
              ? undefined
              : dateColumn(input.anchorOn),
          basis: input.basis,
          nextDueOn,
          usageInterval: input.usageInterval,
          leadDays: input.leadDays,
          graceDays: input.graceDays,
          ownerId: input.ownerId,
        },
      });
      const changes = diffChanges(
        audited(plan),
        audited(updated),
        'maintenance_plan.updated',
      );
      if (Object.keys(changes).length) {
        await this.event(tx, plan.tenantId, id, null, 'updated', {
          to: Object.keys(changes).sort().join(','),
        });
        await this.audit.record(tx, {
          action: 'maintenance_plan.updated',
          targetId: id,
          changes,
        });
      }
      return this.read(tx, updated);
    });
  }

  /** Off, with a reason: nothing new comes due; open work orders stay. */
  deactivate(id: string, reasonCode?: string): Promise<PlanRead> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.planDeactivate,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const plan = await this.findForWrite(tx, id);
      const updated = await tx.maintenancePlan.update({
        where: { id },
        data: { active: false },
      });
      await this.event(tx, plan.tenantId, id, null, 'deactivated', { reason });
      await this.audit.record(tx, {
        action: 'maintenance_plan.deactivated',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      return this.read(tx, updated);
    });
  }

  /** On again, re-timed from today (a calendar plan); never on a retired asset. */
  reactivate(id: string): Promise<PlanRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await this.find(tx, id);
      await this.assets.requireActive(tx, found.assetId);
      const plan = await this.lockPlan(tx, id);
      if (plan.active)
        throw appError.conflict(
          ErrorCode.MAINTENANCE_PLAN_ACTIVE,
          'The plan is on',
        );
      const { today } = await this.calendar.now(tx);
      const open = await this.openOccurrence(tx, id);
      const nextDueOn =
        plan.trigger === 'calendar'
          ? plan.basis === 'floating' && open
            ? null
            : dateColumn(firstDue(seriesOfPlan(plan), today))
          : null;
      const updated = await tx.maintenancePlan.update({
        where: { id },
        data: { active: true, nextDueOn },
      });
      await this.event(tx, plan.tenantId, id, null, 'reactivated', {
        to: ofDateColumnOrNull(nextDueOn),
      });
      await this.audit.record(tx, {
        action: 'maintenance_plan.reactivated',
        targetId: id,
      });
      return this.read(tx, updated);
    });
  }

  /** The next due date (not yet opened) moved, with a reason. */
  defer(
    id: string,
    input: { toDate: LocalDate; reasonCode?: string },
  ): Promise<PlanRead> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.planDefer,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const plan = await this.findForWrite(tx, id);
      const due = this.nextOf(plan);
      const { today } = await this.calendar.now(tx);
      this.requireDeferDate(input.toDate, today, due);
      const updated = await tx.maintenancePlan.update({
        where: { id },
        data: { nextDueOn: dateColumn(input.toDate) },
      });
      await this.event(tx, plan.tenantId, id, null, 'deferred', {
        from: due,
        to: input.toDate,
        reason,
      });
      await this.audit.record(tx, {
        action: 'maintenance_plan.deferred',
        targetId: id,
        changes: { nextDueOn: { from: due, to: input.toDate } },
        metadata: { reasonCode: reason },
      });
      return this.read(tx, updated);
    });
  }

  /** The next due date (not yet opened) skipped, with a reason. */
  skip(id: string, reasonCode?: string): Promise<PlanRead> {
    const reason = requireReasonCodeOnly(reasonCode, REASON_CODES.planSkip);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const plan = await this.findForWrite(tx, id);
      const due = this.nextOf(plan);
      const now = await dbNow(tx);
      const { today } = await this.calendar.now(tx);
      const occurrence = await tx.maintenancePlanOccurrence.create({
        data: {
          id: newId(),
          tenantId: plan.tenantId,
          planId: id,
          originalDueOn: dateColumn(due),
          dueOn: dateColumn(due),
          status: 'skipped',
          generatedAt: now,
          closedAt: now,
          reasonCode: reason,
        },
      });
      const series = seriesOfPlan(plan);
      const next =
        series.basis === 'fixed'
          ? afterGeneration(series, due)!
          : afterDone(series, today);
      const updated = await tx.maintenancePlan.update({
        where: { id },
        data: { nextDueOn: dateColumn(next) },
      });
      await this.event(tx, plan.tenantId, id, occurrence.id, 'skipped', {
        from: due,
        to: next,
        reason,
      });
      await this.audit.record(tx, {
        action: 'maintenance_plan.skipped',
        targetId: id,
        metadata: { reasonCode: reason, dueOn: due },
      });
      return this.read(tx, updated);
    });
  }

  /** An open occurrence's due date moved, with a reason; it may be told of again. */
  deferOccurrence(
    occurrenceId: string,
    input: { toDate: LocalDate; reasonCode?: string },
  ): Promise<MaintenancePlanOccurrence> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.planDefer,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const found = await tx.maintenancePlanOccurrence.findUnique({
        where: { id: occurrenceId },
      });
      if (!found) throw occurrenceNotFound();
      await this.lockPlan(tx, found.planId);
      const occurrence = await this.lockOccurrence(tx, occurrenceId);
      if (occurrence.status !== 'open')
        throw appError.conflict(
          ErrorCode.PLAN_OCCURRENCE_CLOSED,
          'This occurrence has ended',
          {
            params: { status: occurrence.status },
          },
        );
      const { today } = await this.calendar.now(tx);
      const due = ofDateColumn(occurrence.dueOn);
      this.requireDeferDate(input.toDate, today, due);
      const updated = await tx.maintenancePlanOccurrence.update({
        where: { id: occurrenceId },
        data: { dueOn: dateColumn(input.toDate), overdueAlertedAt: null },
      });
      await this.event(
        tx,
        occurrence.tenantId,
        occurrence.planId,
        occurrenceId,
        'deferred',
        {
          from: due,
          to: input.toDate,
          reason,
        },
      );
      await this.audit.record(tx, {
        action: 'maintenance_plan.occurrence_deferred',
        targetId: occurrence.planId,
        changes: { dueOn: { from: due, to: input.toDate } },
        metadata: { occurrenceId, reasonCode: reason },
      });
      return updated;
    });
  }

  /**
   * The sweep, for one plan in its own transaction: when its next due date
   * is within its lead days, the occurrence and its work order (with the
   * checklist's run), and the date after. Decides by what it reads after
   * the locks; returns the new work order's id, or null.
   */
  async generate(
    tx: TenantTxClient,
    tenantId: string,
    planId: string,
  ): Promise<string | null> {
    const seen = await tx.maintenancePlan.findUnique({ where: { id: planId } });
    if (!seen) return null;
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${seen.ownerId}::uuid FOR SHARE`;
    const asset = await this.assets.lockShared(tx, seen.assetId);
    const plan = await this.lockPlan(tx, planId);
    if (!asset || asset.status === 'retired' || !plan.active) return null;
    if (plan.trigger !== 'calendar' || plan.nextDueOn === null) return null;
    const { today } = await this.calendar.now(tx, tenantId);
    const due = ofDateColumn(plan.nextDueOn);
    if (!opensBy(due, plan.leadDays, today)) return null;
    const ticket = await this.open(tx, plan, due);
    const next = afterGeneration(seriesOfPlan(plan), due);
    await tx.maintenancePlan.update({
      where: { id: planId },
      data: { nextDueOn: next === null ? null : dateColumn(next) },
    });
    return ticket.id;
  }

  /** The due plans of the caller's compound, for the sweep. */
  async due(
    tx: TenantTxClient,
    tenantId: string,
    limit: number,
  ): Promise<string[]> {
    const { today } = await this.calendar.now(tx, tenantId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM maintenance_plans
       WHERE active AND trigger = 'calendar' AND next_due_on IS NOT NULL
         AND next_due_on - lead_days <= ${dateColumn(today)}::date
       ORDER BY next_due_on, id
       LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /**
   * The occurrence and its work order for `due`, under the plan's lock:
   * the plan's category and priority, its title for the words, its owner
   * as the reporter, the system as the actor; its checklist's run.
   */
  private async open(
    tx: TenantTxClient,
    plan: MaintenancePlan,
    due: LocalDate,
  ): Promise<Ticket> {
    const ticket = await this.tickets.createWorkOrder(tx, {
      tenantId: plan.tenantId,
      origin: 'plan',
      assetId: plan.assetId,
      categoryId: plan.categoryId,
      priority: plan.priority,
      description: plan.title,
      responsibleId: plan.ownerId,
      actorId: null,
    });
    if (plan.checklistId !== null)
      await this.runs.open(tx, {
        tenantId: plan.tenantId,
        templateId: plan.checklistId,
        ticketId: ticket.id,
        cycle: ticket.cycle,
        assetId: plan.assetId,
      });
    const occurrence = await tx.maintenancePlanOccurrence.create({
      data: {
        id: newId(),
        tenantId: plan.tenantId,
        planId: plan.id,
        originalDueOn: dateColumn(due),
        dueOn: dateColumn(due),
        status: 'open',
        ticketId: ticket.id,
        generatedAt: await dbNow(tx),
      },
    });
    await this.event(tx, plan.tenantId, plan.id, occurrence.id, 'generated', {
      to: due,
    });
    return ticket;
  }

  /**
   * New readings (ADR 0064): a usage plan of the asset's metric comes due
   * today when the readings grew by its interval since the last service,
   * unless one is open, or one came due today already. The work order is
   * offered by the dispatch sweep (the reading's transaction is still open).
   */
  private async usage(tx: TenantTxClient, rows: AssetReading[]): Promise<void> {
    const byAsset = new Map<string, AssetReading[]>();
    for (const r of rows)
      byAsset.set(r.assetId, [...(byAsset.get(r.assetId) ?? []), r]);
    for (const [assetId, readings] of [...byAsset].sort(([x], [y]) =>
      x.localeCompare(y),
    )) {
      const plans = await tx.maintenancePlan.findMany({
        where: {
          assetId,
          active: true,
          trigger: 'usage',
          metricKey: { in: [...new Set(readings.map((r) => r.metricKey))] },
        },
        orderBy: { id: 'asc' },
      });
      if (!plans.length) continue;
      for (const seen of plans)
        await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${seen.ownerId}::uuid FOR SHARE`;
      const asset = await this.assets.lockShared(tx, assetId);
      if (!asset || asset.status === 'retired') continue;
      for (const seen of plans) {
        const plan = await this.lockPlan(tx, seen.id);
        if (!plan.active) continue;
        const latest = readings
          .filter((r) => r.metricKey === plan.metricKey)
          .reduce((a, b) => (b.value.greaterThan(a.value) ? b : a));
        const last =
          plan.usageLastValue === null ? null : plan.usageLastValue.toNumber();
        if (
          !usageDue(
            latest.value.toNumber(),
            last,
            plan.usageInterval!.toNumber(),
          )
        )
          continue;
        if (await this.openOccurrence(tx, plan.id)) continue;
        const { today } = await this.calendar.now(tx, plan.tenantId);
        if (
          await tx.maintenancePlanOccurrence.count({
            where: { planId: plan.id, originalDueOn: dateColumn(today) },
          })
        )
          continue;
        await this.open(tx, plan, today);
        await tx.maintenancePlan.update({
          where: { id: plan.id },
          data: { usageLastValue: latest.value },
        });
      }
    }
  }

  /** A plan's work order completed: its occurrence is done, on time or not. */
  private async completing(tx: TenantTxClient, ticket: Ticket): Promise<void> {
    if (ticket.origin !== 'plan') return;
    const found = await tx.maintenancePlanOccurrence.findFirst({
      where: { ticketId: ticket.id },
    });
    if (!found) return;
    const plan = await this.lockPlan(tx, found.planId);
    const occurrence = await this.lockOccurrence(tx, found.id);
    if (occurrence.status !== 'open') return;
    const { now, today } = await this.calendar.now(tx, plan.tenantId);
    const due = ofDateColumn(occurrence.dueOn);
    await tx.maintenancePlanOccurrence.update({
      where: { id: occurrence.id },
      data: {
        status: 'done',
        closedAt: now,
        doneOn: dateColumn(today),
        onTime: onTime(due, plan.graceDays, today),
      },
    });
    if (plan.trigger === 'calendar' && plan.basis === 'floating' && plan.active)
      await tx.maintenancePlan.update({
        where: { id: plan.id },
        data: { nextDueOn: dateColumn(afterDone(seriesOfPlan(plan), today)) },
      });
    if (plan.trigger === 'usage') {
      const last = await this.lastValue(tx, plan.assetId, plan.metricKey!);
      if (last !== null)
        await tx.maintenancePlan.update({
          where: { id: plan.id },
          data: { usageLastValue: last },
        });
    }
    await this.event(tx, plan.tenantId, plan.id, occurrence.id, 'done', {
      to: today,
      reason: onTime(due, plan.graceDays, today) ? null : 'late',
    });
  }

  /** A plan's work order cancelled: its occurrence ends, the series goes on. */
  private async cancelling(tx: TenantTxClient, ticket: Ticket): Promise<void> {
    if (ticket.origin !== 'plan') return;
    const found = await tx.maintenancePlanOccurrence.findFirst({
      where: { ticketId: ticket.id },
    });
    if (!found) return;
    const plan = await this.lockPlan(tx, found.planId);
    const occurrence = await this.lockOccurrence(tx, found.id);
    if (occurrence.status !== 'open') return;
    const { now, today } = await this.calendar.now(tx, plan.tenantId);
    await tx.maintenancePlanOccurrence.update({
      where: { id: occurrence.id },
      data: {
        status: 'cancelled',
        closedAt: now,
        reasonCode: 'ticket_cancelled',
      },
    });
    if (plan.trigger === 'calendar' && plan.basis === 'floating' && plan.active)
      await tx.maintenancePlan.update({
        where: { id: plan.id },
        data: { nextDueOn: dateColumn(afterDone(seriesOfPlan(plan), today)) },
      });
    await this.event(tx, plan.tenantId, plan.id, occurrence.id, 'cancelled', {
      reason: 'ticket_cancelled',
    });
  }

  /** The plan with its record so far. */
  private async read(
    tx: TenantTxClient,
    plan: MaintenancePlan,
  ): Promise<PlanRead> {
    const { today } = await this.calendar.now(tx, plan.tenantId);
    const [counts] = await tx.$queryRaw<
      { done: bigint; on_time: bigint; overdue: bigint; open: bigint }[]
    >`
      SELECT count(*) FILTER (WHERE status = 'done') AS done,
             count(*) FILTER (WHERE status = 'done' AND on_time) AS on_time,
             count(*) FILTER (WHERE status = 'open'
                              AND due_on + ${plan.graceDays}::int < ${dateColumn(today)}::date) AS overdue,
             count(*) FILTER (WHERE status = 'open') AS open
        FROM maintenance_plan_occurrences WHERE plan_id = ${plan.id}::uuid`;
    return {
      plan,
      stats: {
        done: Number(counts.done),
        onTime: Number(counts.on_time),
        overdue: Number(counts.overdue),
        open: Number(counts.open),
      },
    };
  }

  async find(tx: TenantTxClient, id: string): Promise<MaintenancePlan> {
    const plan = await tx.maintenancePlan.findUnique({ where: { id } });
    if (!plan) throw planNotFound();
    return plan;
  }

  /** For a write: the asset shared (not retired), then the plan, active. */
  private async findForWrite(
    tx: TenantTxClient,
    id: string,
  ): Promise<MaintenancePlan> {
    const seen = await this.find(tx, id);
    await this.assets.lockShared(tx, seen.assetId);
    const plan = await this.lockPlan(tx, id);
    if (!plan.active)
      throw appError.conflict(
        ErrorCode.MAINTENANCE_PLAN_INACTIVE,
        'The plan is off',
      );
    return plan;
  }

  private async lockPlan(
    tx: TenantTxClient,
    id: string,
  ): Promise<MaintenancePlan> {
    await tx.$queryRaw`SELECT id FROM maintenance_plans WHERE id = ${id}::uuid FOR UPDATE`;
    return this.find(tx, id);
  }

  private async lockOccurrence(
    tx: TenantTxClient,
    id: string,
  ): Promise<MaintenancePlanOccurrence> {
    await tx.$queryRaw`SELECT id FROM maintenance_plan_occurrences WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.maintenancePlanOccurrence.findUniqueOrThrow({ where: { id } });
  }

  private openOccurrence(
    tx: TenantTxClient,
    planId: string,
  ): Promise<MaintenancePlanOccurrence | null> {
    return tx.maintenancePlanOccurrence.findFirst({
      where: { planId, status: 'open' },
    });
  }

  /** A calendar plan's next due date not yet opened, or 409. */
  private nextOf(plan: MaintenancePlan): LocalDate {
    if (plan.trigger !== 'calendar')
      throw appError.conflict(
        ErrorCode.MAINTENANCE_PLAN_BY_USAGE,
        'A usage plan has no due date',
      );
    if (plan.nextDueOn === null)
      throw appError.conflict(
        ErrorCode.PLAN_OCCURRENCE_OPEN,
        'Its work order is open: defer that occurrence instead',
      );
    return ofDateColumn(plan.nextDueOn);
  }

  /** A new date: real, from today, within a year, not the same. */
  private requireDeferDate(
    to: LocalDate,
    today: LocalDate,
    current: LocalDate,
  ): void {
    const code = !isRealDate(to)
      ? FieldErrorCode.INVALID_FORMAT
      : to < today || to > addDays(today, MAX_DEFER_DAYS)
        ? FieldErrorCode.INVALID_VALUE
        : to === current
          ? FieldErrorCode.SAME_AS_CURRENT
          : null;
    if (code) throw invalid([{ field: 'toDate', code }]);
  }

  /** The owner answers for the work orders: an active dispatcher. */
  private async requireOwner(
    tx: TenantTxClient,
    ownerId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${ownerId}::uuid FOR SHARE`;
    const ok = await tx.account.count({
      where: {
        id: ownerId,
        status: 'active',
        role: { permissions: { some: { permission: 'tickets.dispatch' } } },
      },
    });
    if (!ok)
      throw invalid([
        { field: 'ownerId', code: FieldErrorCode.PLAN_OWNER_NOT_ELIGIBLE },
      ]);
  }

  private async requireCategory(
    tx: TenantTxClient,
    id: string,
    given: boolean,
  ): Promise<void> {
    if (await tx.ticketCategory.count({ where: { id, active: true } })) return;
    throw invalid([
      {
        field: given ? 'categoryId' : 'assetId',
        code: FieldErrorCode.CATEGORY_NOT_AVAILABLE,
      },
    ]);
  }

  private async lastValue(
    tx: TenantTxClient,
    assetId: string,
    metricKey: string,
  ) {
    const r = await tx.assetReading.findFirst({
      where: { assetId, metricKey },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
    return r?.value ?? null;
  }

  private async event(
    tx: TenantTxClient,
    tenantId: string,
    planId: string,
    occurrenceId: string | null,
    kind: MaintenancePlanEvent['kind'],
    v: { from?: string | null; to?: string | null; reason?: string | null },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO maintenance_plan_events
        (id, tenant_id, plan_id, occurrence_id, kind, from_value, to_value,
         reason_code, actor_account_id, occurred_at)
      VALUES (${newId()}::uuid, ${tenantId}::uuid, ${planId}::uuid,
              ${occurrenceId}::uuid, ${kind}, ${v.from ?? null}, ${v.to ?? null},
              ${v.reason ?? null}, ${this.ctx.accountIdOrNull()}::uuid,
              date_trunc('milliseconds', clock_timestamp()))`;
  }
}

/** A calendar plan's series and basis, from its row. */
function seriesOfPlan(p: MaintenancePlan): CalendarSeries {
  return {
    every: p.every!,
    unit: p.unit as RecurrenceUnit,
    anchorOn: ofDateColumn(p.anchorOn!),
    basis: p.basis as PlanBasis,
  };
}

function seriesOf(i: Partial<CalendarSeries>): CalendarSeries {
  return {
    every: i.every!,
    unit: i.unit!,
    anchorOn: i.anchorOn!,
    basis: i.basis ?? 'fixed',
  };
}

function definedOf<T extends object, K extends keyof T>(
  o: T,
  keys: readonly K[],
): Partial<T> {
  return Object.fromEntries(
    keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
  ) as unknown as Partial<T>;
}

/** What each trigger takes: a series, or a metric and its interval. */
export function shapeProblems(i: PlanInput): FieldError[] {
  const fields: FieldError[] = [];
  const need = (f: keyof PlanInput) => {
    if (i[f] === undefined)
      fields.push({ field: f, code: FieldErrorCode.FIELD_REQUIRED });
  };
  const not = (f: keyof PlanInput) => {
    if (i[f] !== undefined)
      fields.push({ field: f, code: FieldErrorCode.FIELD_NOT_ALLOWED });
  };
  if (i.trigger === 'calendar') {
    need('every');
    need('unit');
    need('anchorOn');
    not('metricKey');
    not('usageInterval');
    if (i.anchorOn !== undefined && !isRealDate(i.anchorOn))
      fields.push({ field: 'anchorOn', code: FieldErrorCode.INVALID_FORMAT });
  } else {
    need('metricKey');
    need('usageInterval');
    for (const f of ['every', 'unit', 'anchorOn', 'basis'] as const) not(f);
  }
  return fields;
}

/** Codes, days and the owner; the title as `{ changed: true }`. */
function audited(p: MaintenancePlan) {
  return {
    assetId: p.assetId,
    checklistId: p.checklistId,
    title: p.title,
    categoryId: p.categoryId,
    priority: p.priority,
    trigger: p.trigger,
    every: p.every,
    unit: p.unit,
    anchorOn: ofDateColumnOrNull(p.anchorOn),
    basis: p.basis,
    metricKey: p.metricKey,
    usageInterval: p.usageInterval?.toFixed(4) ?? null,
    leadDays: p.leadDays,
    graceDays: p.graceDays,
    ownerId: p.ownerId,
    active: p.active,
  };
}
