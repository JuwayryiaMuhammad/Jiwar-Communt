import { Injectable } from '@nestjs/common';
import type {
  PatrolRoute,
  PatrolRouteVersion,
  PatrolRun,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { addDays, localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SafetyCore } from '../safety/safety-core';
import { HORIZON_DAYS, runOccurrences, scheduleOf } from './patrol-rules';

/** Why a run under way ended short, as `patrol.incomplete` says it. */
export type IncompleteReason = 'guard' | 'shift_ended' | 'timed_out';

/**
 * What the run services share (ADR 0052): making a version's scheduled
 * runs, cancelling those nobody started, the run's row lock, and ending a
 * run under way — the keepers told when it ends short.
 */
@Injectable()
export class RunsCore {
  constructor(
    private readonly audit: AuditService,
    private readonly safety: SafetyCore,
  ) {}

  /**
   * The version's scheduled runs, HORIZON_DAYS ahead from `now`, those to
   * start after it. Each is made once: the unique index keeps cancelled
   * ones too, so nothing cancelled comes back. The caller holds the route
   * (FOR SHARE or FOR UPDATE), so a new version waits or is seen.
   */
  async generate(
    tx: TenantTxClient,
    route: PatrolRoute,
    version: PatrolRouteVersion,
    now: Date,
    timeZone: string,
  ): Promise<number> {
    const schedule = scheduleOf(version.schedule);
    if (!schedule || route.retiredAt || version.supersededAt) return 0;
    const today = localDate(now, timeZone);
    const coming = runOccurrences(
      schedule,
      version.expectedMinutes,
      today,
      addDays(today, HORIZON_DAYS),
      timeZone,
    ).filter((o) => o.startsAt > now);
    if (!coming.length) return 0;
    const total = await tx.patrolRouteCheckpoint.count({
      where: { versionId: version.id },
    });
    const made = await tx.patrolRun.createMany({
      data: coming.map((o) => ({
        id: newId(),
        tenantId: route.tenantId,
        routeId: route.id,
        versionId: version.id,
        gateId: route.gateId,
        placeId: route.placeId,
        kind: 'scheduled' as const,
        plannedAt: o.startsAt,
        scheduledStart: o.startsAt,
        windowEndsAt: o.endsAt,
        status: 'scheduled' as const,
        checkpointsTotal: total,
      })),
      skipDuplicates: true,
    });
    return made.count;
  }

  /**
   * The route's scheduled runs nobody started, cancelled by the system:
   * each taken FOR UPDATE in id order, so a start holding one finished
   * first (and it is under way) or finds it cancelled.
   */
  async cancelScheduled(
    tx: TenantTxClient,
    routeId: string,
    reason: 'route_changed' | 'route_retired',
    now: Date,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patrol_runs
       WHERE route_id = ${routeId}::uuid AND status = 'scheduled'
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return 0;
    const { count } = await tx.patrolRun.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: 'scheduled' },
      data: { status: 'cancelled', cancelReason: reason, endedAt: now },
    });
    return count;
  }

  /** The run FOR UPDATE, or null. */
  async lockRun(tx: TenantTxClient, id: string): Promise<PatrolRun | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patrol_runs WHERE id = ${id}::uuid FOR UPDATE`;
    return row ? tx.patrolRun.findUniqueOrThrow({ where: { id } }) : null;
  }

  /**
   * Ends a run under way the caller holds: completed when every checkpoint
   * was scanned, else incomplete (`guard`, `shift_ended`) or timed out. A
   * run ending short tells the roster's keepers, in this transaction.
   */
  async end(
    tx: TenantTxClient,
    run: PatrolRun,
    how: 'completed' | IncompleteReason,
    now: Date,
  ): Promise<PatrolRun> {
    const status =
      how === 'completed'
        ? 'completed'
        : how === 'timed_out'
          ? 'timed_out'
          : 'incomplete';
    const ended = await tx.patrolRun.update({
      where: { id: run.id },
      data: {
        status,
        endedAt: now,
        endReason: status === 'incomplete' ? how : null,
      },
    });
    const told =
      how === 'completed'
        ? 0
        : await this.safety.notify(
            tx,
            await this.safety.holding(tx, 'guard_roster.manage'),
            'patrol.incomplete',
            run.id,
            { reason: how },
          );
    await this.audit.record(tx, {
      action: how === 'timed_out' ? 'patrol_run.timed_out' : 'patrol_run.ended',
      targetId: run.id,
      metadata: {
        status,
        scanned: ended.scannedCount,
        total: ended.checkpointsTotal,
        ...(how === 'completed' || how === 'timed_out' ? {} : { reason: how }),
        recipients: told,
      },
    });
    return ended;
  }
}
