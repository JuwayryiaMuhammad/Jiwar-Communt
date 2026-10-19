import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PatrolRun } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { runNotFound } from './guard-patrols.service';
import { PatrolGeofence } from './patrol-geofence';
import {
  inRunLifetime,
  TRACK_AFTER_END_MINUTES,
  TRACK_READ_MAX,
  TRACK_RETENTION_DAYS,
} from './patrol-rules';
import { GeofenceExitView, TrackPointView } from './views/track.views';

export const PATROL_TRACK_PURGE_SWEEP = 'gate.patrol_track_purge';
const MINUTE = 60_000;
const DAY = 86_400_000;

export interface TrackPointInput {
  recordedAt: Date;
  lat: number;
  lng: number;
  accuracyM?: number;
}

/**
 * Where a guard walked during a run (ADR 0052). The app sends its positions
 * in batches while the run is under way, and up to 30 minutes after it
 * ended (its offline queue); a point at an instant already recorded is
 * ignored. The guard's location is personal data: read by `patrols.manage`
 * and by the guard on their own runs, never by `guard_reports.read` or
 * another guard; deleted by an hourly sweep 30 days after it was recorded
 * — unless an incident keeps the run's track (ADR 0056) — and at the
 * guard's erasure. A run whose route version has a geofence is watched as
 * its points arrive (PatrolGeofence).
 *
 * Lock order: the guard's account (FOR SHARE: an erasure deleting their
 * points waits, or ran first and they are signed out), then the run (FOR
 * UPDATE: two batches of one run one after the other; a purge skips it).
 */
@Injectable()
export class PatrolTrackService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
    private readonly safety: SafetyCore,
    private readonly geofence: PatrolGeofence,
  ) {}

  onModuleInit(): void {
    this.sweep.register(PATROL_TRACK_PURGE_SWEEP, (now) => this.purge(now));
  }

  /**
   * A batch of my run's points. The run is locked: under way, or ended 30
   * minutes ago at most (409 PATROL_RUN_NOT_LIVE). A point outside its
   * lifetime (two minutes either side) is dropped, as one already recorded
   * is ignored: the rest are kept. `rejected` counts the dropped. The new
   * points after every one before are walked against its geofence.
   */
  record(
    runId: string,
    points: readonly TrackPointInput[],
  ): Promise<{ accepted: number; rejected: number }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM patrol_runs WHERE id = ${runId}::uuid FOR UPDATE`;
      const run = row
        ? await tx.patrolRun.findUniqueOrThrow({ where: { id: runId } })
        : null;
      if (!run || run.guardAccountId !== this.ctx.accountId)
        throw runNotFound();
      const now = await dbNow(tx);
      const open =
        run.status === 'in_progress' ||
        (run.endedAt !== null &&
          now.getTime() <=
            run.endedAt.getTime() + TRACK_AFTER_END_MINUTES * MINUTE);
      if (!open)
        throw appError.conflict(
          ErrorCode.PATROL_RUN_NOT_LIVE,
          'The run is not under way',
          { params: { status: run.status } },
        );
      const lifetime = { startedAt: run.startedAt!, endedAt: run.endedAt };
      const inside = points.filter((p) =>
        inRunLifetime(lifetime, p.recordedAt, now),
      );
      const rejected = points.length - inside.length;
      if (!inside.length) return { accepted: 0, rejected };
      const fence = await this.geofence.fenceOf(tx, run);
      const last = fence
        ? (
            await tx.patrolTrackPoint.aggregate({
              where: { runId },
              _max: { recordedAt: true },
            })
          )._max.recordedAt
        : null;
      const created = await tx.patrolTrackPoint.createManyAndReturn({
        data: inside.map((p) => ({
          id: newId(),
          tenantId: this.ctx.txTenantId,
          runId,
          guardAccountId: this.ctx.accountId,
          recordedAt: p.recordedAt,
          lat: p.lat,
          lng: p.lng,
          accuracyM: p.accuracyM ?? null,
          receivedAt: now,
        })),
        skipDuplicates: true,
      });
      if (fence)
        await this.geofence.walk(
          tx,
          run,
          fence,
          created
            .filter((p) => !last || p.recordedAt > last)
            .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime()),
        );
      return { accepted: created.length, rejected };
    });
  }

  /** My own run's points, in order. */
  mine(runId: string): Promise<TrackPointView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await tx.patrolRun.findUnique({ where: { id: runId } });
      if (!run || run.guardAccountId !== this.ctx.accountId)
        throw runNotFound();
      return this.points(tx, run);
    });
  }

  /** A run's points, for `patrols.manage`. */
  forStaff(runId: string): Promise<TrackPointView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await tx.patrolRun.findUnique({ where: { id: runId } });
      if (!run) throw runNotFound();
      return this.points(tx, run);
    });
  }

  /** A run's geofence exits, for `patrols.manage`: times, never where. */
  exitsForStaff(runId: string): Promise<GeofenceExitView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await tx.patrolRun.findUnique({ where: { id: runId } });
      if (!run) throw runNotFound();
      return (await this.geofence.exits(tx, runId)).map((e) =>
        GeofenceExitView.of(e),
      );
    });
  }

  /**
   * Points recorded 30 days ago or more, one compound at a time and run by
   * run; how many went is audited, never where. A run an incident keeps
   * (`incident_evidence`, ADR 0056) keeps its points. Each run is taken FOR
   * UPDATE SKIP LOCKED — a link holds it FOR SHARE, and is left for the
   * next pass — and whether it is kept is read under that lock, after a
   * link that committed first.
   */
  purge(now: Date): Promise<number> {
    const before = new Date(now.getTime() - TRACK_RETENTION_DAYS * DAY);
    return this.sweep.forEachTenant(async (tx) => {
      const runs = await tx.$queryRaw<{ run_id: string }[]>`
        SELECT DISTINCT run_id FROM patrol_track_points
         WHERE recorded_at < ${before} ORDER BY run_id`;
      let count = 0;
      for (const { run_id } of runs) {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM patrol_runs WHERE id = ${run_id}::uuid
             FOR UPDATE SKIP LOCKED`;
        if (!locked.length) continue;
        const kept = await tx.incidentEvidence.count({
          where: { runId: run_id },
        });
        if (kept) continue;
        count += (
          await tx.patrolTrackPoint.deleteMany({
            where: { runId: run_id, recordedAt: { lt: before } },
          })
        ).count;
      }
      if (count)
        await this.audit.record(tx, {
          action: 'patrol_track.purged',
          targetId: null,
          metadata: { points: count },
        });
      return count;
    });
  }

  private async points(
    tx: TenantTxClient,
    run: PatrolRun,
  ): Promise<TrackPointView[]> {
    const rows = await tx.patrolTrackPoint.findMany({
      where: { runId: run.id },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      take: TRACK_READ_MAX,
    });
    return rows.map((p) => TrackPointView.of(p));
  }
}
