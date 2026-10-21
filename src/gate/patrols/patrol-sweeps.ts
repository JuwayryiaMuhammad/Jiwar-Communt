import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { RosterCore } from '../roster/roster-core';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService, type EndedShift } from '../shifts/shifts.service';
import { PatrolCore } from './patrol-core';
import {
  EXPECTED_MINUTES,
  lateAfter,
  LATE_AFTER_MINUTES,
  TIMEOUT_FACTOR,
  timeoutAt,
  endStatus,
} from './patrol-rules';
import { RunsCore } from './runs-core';

export const PATROL_SCHEDULE_SWEEP = 'gate.patrol_schedule';
export const PATROL_WATCH_SWEEP = 'gate.patrol_watch';
/** Often enough that "15 minutes late" is at most a minute more. */
export const WATCH_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 200;
const MINUTE = 60_000;

/**
 * What happens to runs on their own (ADR 0052).
 *
 * - **Made ahead** (an hourly sweep): each route in service's current
 *   version keeps its scheduled runs made 7 days ahead, under the route's
 *   share lock (a new version waits, or is seen).
 * - **Watched** (a sweep every minute): each run is taken FOR UPDATE SKIP
 *   LOCKED and judged again under the lock by the database's clock, so a
 *   start holding it wins:
 *   - late, once: not started 15 minutes after its start, or after it was
 *     made if later; the guards on shift at its post are told
 *     (`patrol.late`);
 *   - missed, once: not started when its window ends; the roster's keepers
 *     are told (`patrol.missed`). At a post out of service it is cancelled
 *     instead (`post_out_of_service`) and nobody is told;
 *   - timed out: under way twice its expected minutes; closed, and the
 *     keepers told (`patrol.incomplete`).
 * - **A shift's end** (an end hook, for every end): the guard's run under
 *   way ends incomplete (`shift_ended`), the keepers told.
 */
@Injectable()
export class PatrolSweeps implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly shifts: ShiftsService,
    private readonly roster: RosterCore,
    private readonly safety: SafetyCore,
    private readonly audit: AuditService,
    private readonly core: PatrolCore,
    private readonly runs: RunsCore,
  ) {}

  onModuleInit(): void {
    this.shifts.onEnded((tx, shift) => this.endLiveRun(tx, shift));
    this.sweep.register(PATROL_SCHEDULE_SWEEP, (now) => this.makeDue(now));
    this.sweep.register(PATROL_WATCH_SWEEP, (now) => this.watch(now), {
      intervalMs: WATCH_INTERVAL_MS,
    });
  }

  /** Every route in service's scheduled runs, 7 days ahead; one transaction each. */
  makeDue(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.patrolRoute.findMany({
            where: { retiredAt: null },
            orderBy: { id: 'asc' },
            select: { id: true },
          })
        ).map((r) => r.id),
      async (tx, _tenantId, id) => {
        const route = await this.core.shareRoute(tx, id);
        if (!route || route.retiredAt) return 0;
        return this.runs.generate(
          tx,
          route,
          await this.core.currentVersion(tx, id),
          now,
          await this.roster.timeZone(tx),
        );
      },
    );
  }

  /**
   * Runs due a look: scheduled ones late or past their window, and those
   * under way long enough to time out. Each in its own transaction.
   */
  watch(now: Date): Promise<number> {
    const lateDue = new Date(now.getTime() - LATE_AFTER_MINUTES * MINUTE);
    // The shortest run times out after twice the fewest expected minutes.
    const liveDue = new Date(
      now.getTime() - TIMEOUT_FACTOR * EXPECTED_MINUTES.min * MINUTE,
    );
    return this.sweep.forEachTenantItem(
      async (tx) =>
        (
          await tx.patrolRun.findMany({
            where: {
              OR: [
                { status: 'scheduled', windowEndsAt: { lte: now } },
                {
                  status: 'scheduled',
                  lateAt: null,
                  scheduledStart: { lte: lateDue },
                  createdAt: { lte: lateDue },
                },
                { status: 'in_progress', startedAt: { lte: liveDue } },
              ],
            },
            orderBy: [{ plannedAt: 'asc' }, { id: 'asc' }],
            take: SWEEP_BATCH,
            select: { id: true },
          })
        ).map((r) => r.id),
      (tx, _tenantId, id) => this.judge(tx, id),
    );
  }

  private async judge(tx: TenantTxClient, id: string): Promise<number> {
    const [claimed] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patrol_runs WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
    if (!claimed) return 0;
    const run = await tx.patrolRun.findUniqueOrThrow({ where: { id } });
    const at = await dbNow(tx);
    if (run.status === 'in_progress') {
      const version = await tx.patrolRouteVersion.findUniqueOrThrow({
        where: { id: run.versionId },
      });
      if (at < timeoutAt(run.startedAt!, version.expectedMinutes)) return 0;
      await this.runs.end(tx, run, 'timed_out', at);
      return 1;
    }
    if (run.status !== 'scheduled') return 0;
    const inService = await this.core.inService(tx, run);
    if (at >= run.windowEndsAt!) {
      if (!inService) {
        await tx.patrolRun.update({
          where: { id },
          data: {
            status: 'cancelled',
            cancelReason: 'post_out_of_service',
            endedAt: at,
          },
        });
        await this.audit.record(tx, {
          action: 'patrol_run.cancelled',
          targetId: id,
          metadata: { reason: 'post_out_of_service' },
        });
        return 1;
      }
      await tx.patrolRun.update({
        where: { id },
        data: { status: 'missed', endedAt: at },
      });
      const recipients = await this.safety.notify(
        tx,
        await this.safety.holding(tx, 'guard_roster.manage'),
        'patrol.missed',
        id,
      );
      await this.audit.record(tx, {
        action: 'patrol_run.missed',
        targetId: id,
        metadata: { recipients },
      });
      return 1;
    }
    // A post out of service is nobody's lateness.
    if (
      run.lateAt ||
      at <
        lateAfter({
          scheduledStart: run.scheduledStart!,
          createdAt: run.createdAt,
        }) ||
      !inService
    )
      return 0;
    await tx.patrolRun.update({ where: { id }, data: { lateAt: at } });
    const recipients = await this.safety.notify(
      tx,
      await this.safety.guardsOnShift(
        tx,
        run.gateId ?? { placeId: run.placeId! },
      ),
      'patrol.late',
      id,
    );
    await this.audit.record(tx, {
      action: 'patrol_run.late',
      targetId: id,
      metadata: { recipients },
    });
    return 1;
  }

  /**
   * The guard's run under way, in the shift's end transaction, under its
   * row lock: a scan holding it finished first.
   */
  private async endLiveRun(
    tx: TenantTxClient,
    shift: EndedShift,
  ): Promise<void> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patrol_runs
       WHERE guard_account_id = ${shift.guardAccountId}::uuid
         AND status = 'in_progress'
       FOR UPDATE`;
    if (!row) return;
    const run = await tx.patrolRun.findUniqueOrThrow({ where: { id: row.id } });
    const at = await dbNow(tx);
    await this.runs.end(
      tx,
      run,
      endStatus(run.scannedCount, run.checkpointsTotal) === 'completed'
        ? 'completed'
        : 'shift_ended',
      at > run.startedAt! ? at : run.startedAt!,
    );
  }
}
