import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { StaffRecipients } from '../../core/access/staff-recipients';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { DispatchBusyError } from '../dispatch/dispatch-busy';
import { DispatchEngine } from '../dispatch/dispatch-engine';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { dateColumn, ofDateColumn } from '../schedules/local-dates';
import { overdue } from './plan-rules';
import { PlansService } from './plans.service';

export const PLAN_SWEEP = 'maintenance.plans';
/** A due date opens on a day; a quarter of an hour is soon enough. */
export const PLAN_SWEEP_INTERVAL_MS = 15 * 60_000;
/** Plans one run opens, and occurrences it tells of, per compound. */
export const PLAN_BATCH = 200;

/**
 * The plans' time-driven work (ADR 0064), every compound, each item in a
 * transaction of its own:
 *
 * - **open:** each calendar plan whose next due date is within its lead
 *   days gets its occurrence and work order (PlansService.generate);
 * - **dispatch:** each work order opened is offered to the engine at once,
 *   in a transaction of its own (a busy engine leaves it to its sweep);
 * - **overdue:** each open occurrence past its grace is told of once, to
 *   its plan's owner and every dispatcher.
 */
@Injectable()
export class PlanSweep implements OnModuleInit {
  private readonly logger = new Logger(PlanSweep.name);

  constructor(
    private readonly sweep: SweepRunner,
    private readonly plans: PlansService,
    private readonly engine: DispatchEngine,
    private readonly calendar: CompoundCalendar,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.sweep.register(PLAN_SWEEP, () => this.run(), {
      intervalMs: PLAN_SWEEP_INTERVAL_MS,
    });
  }

  /** Work orders opened, and overdue occurrences told of. */
  async run(): Promise<number> {
    const opened = new Map<string, string[]>();
    let done = await this.sweep.forEachTenantItem(
      (tx, tenantId) => this.plans.due(tx, tenantId, PLAN_BATCH),
      async (tx, tenantId, planId) => {
        const ticketId = await this.plans.generate(tx, tenantId, planId);
        if (!ticketId) return 0;
        opened.set(tenantId, [...(opened.get(tenantId) ?? []), ticketId]);
        return 1;
      },
    );
    await this.sweep.forEachTenantItem(
      (_tx, tenantId) => Promise.resolve(opened.get(tenantId) ?? []),
      async (tx, _tenantId, ticketId) => {
        try {
          await this.engine.run(tx, ticketId, 'created');
        } catch (error) {
          if (!(error instanceof DispatchBusyError)) throw error;
          this.logger.warn(
            'dispatch lock busy: a plan’s work order waits for its sweep',
          );
        }
        return 0;
      },
    );
    done += await this.sweep.forEachTenantItem(
      (tx, tenantId) => this.overdueOnes(tx, tenantId),
      (tx, tenantId, id) => this.tell(tx, tenantId, id),
    );
    return done;
  }

  private async overdueOnes(
    tx: TenantTxClient,
    tenantId: string,
  ): Promise<string[]> {
    const { today } = await this.calendar.now(tx, tenantId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT o.id FROM maintenance_plan_occurrences o
        JOIN maintenance_plans p ON p.id = o.plan_id
       WHERE o.status = 'open' AND o.overdue_alerted_at IS NULL
         AND o.due_on + p.grace_days < ${dateColumn(today)}::date
       ORDER BY o.due_on, o.id
       LIMIT ${PLAN_BATCH}`;
    return rows.map((r) => r.id);
  }

  /** Once: the plan shared, the occurrence locked, decided after the locks. */
  private async tell(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    const seen = await tx.maintenancePlanOccurrence.findUnique({
      where: { id },
    });
    if (!seen) return 0;
    await tx.$queryRaw`SELECT id FROM maintenance_plans WHERE id = ${seen.planId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM maintenance_plan_occurrences WHERE id = ${id}::uuid FOR UPDATE`;
    const occurrence = await tx.maintenancePlanOccurrence.findUniqueOrThrow({
      where: { id },
    });
    const plan = await tx.maintenancePlan.findUniqueOrThrow({
      where: { id: seen.planId },
    });
    const { now, today } = await this.calendar.now(tx, tenantId);
    const due = ofDateColumn(occurrence.dueOn);
    if (
      occurrence.status !== 'open' ||
      occurrence.overdueAlertedAt !== null ||
      !overdue(due, plan.graceDays, today)
    )
      return 0;
    await tx.maintenancePlanOccurrence.update({
      where: { id },
      data: { overdueAlertedAt: now },
    });
    await tx.$executeRaw`
      INSERT INTO maintenance_plan_events
        (id, tenant_id, plan_id, occurrence_id, kind, to_value, occurred_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${plan.id}::uuid, ${id}::uuid,
              'overdue', ${due}, ${now})`;
    const asset = await tx.asset.findUniqueOrThrow({
      where: { id: plan.assetId },
    });
    const dispatchers = (await this.staff.holding(tx, 'tickets.dispatch')).map(
      (r) => r.id,
    );
    const active = await tx.account.findMany({
      where: {
        id: { in: [...new Set([plan.ownerId, ...dispatchers])] },
        status: 'active',
      },
      select: { id: true },
    });
    await this.notifier.notify(
      tx,
      active.map((a) => a.id),
      {
        kind: 'maintenance.plan_overdue',
        params: { assetRef: asset.code, dueOn: due },
        targetId: plan.id,
      },
    );
    return 1;
  }
}
