import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ControlRoom } from '../control-room/control-room';
import type { PatrolGeofenceExit, PatrolRun } from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { GateSettingsService } from '../settings/gate-settings.service';
import {
  exitLasted,
  geofenceOf,
  isOutside,
  walkExits,
  type Geofence,
} from './geofence';
import { WATCH_INTERVAL_MS } from './patrol-sweeps';

export const PATROL_GEOFENCE_SWEEP = 'gate.patrol_geofence';
const MINUTE = 60_000;
/** How far back the sweep looks for an open exit: no run lasts longer. */
const SWEEP_LOOKBACK_HOURS = 24;

/** A new point of a run, as the walk takes it. */
export interface WalkedPoint {
  recordedAt: Date;
  lat: number;
  lng: number;
  accuracyM: number | null;
}

/**
 * A patrol's geofence (ADR 0056): each time the guard of a run whose route
 * version has one is outside it. Under the run's lock (FOR UPDATE: two
 * batches of one run walk one after the other), the batch's new points
 * are walked in time order from where the last batch left off — an outside
 * point opens an exit, the next inside one closes it. A point older than
 * one already walked stays in the track but is not walked: the app sends
 * its queue in order.
 *
 * An exit is flagged once it lasted the gate's `geofence_exit_minutes`:
 * by the batch that shows it (to its return, or to its latest point
 * outside), or by the sweep while it is open and no point says more (to
 * now, or to the run's end). Once per exit: `flagged_at` is set by an
 * update that finds it unset, under the run's lock either way. A flag
 * tells the `patrols.manage` holders, with the minutes and never where.
 */
@Injectable()
export class PatrolGeofence implements OnModuleInit {
  constructor(
    private readonly sweep: SweepRunner,
    private readonly settings: GateSettingsService,
    private readonly safety: SafetyCore,
    private readonly controlRoom: ControlRoom,
  ) {}

  onModuleInit(): void {
    this.sweep.register(PATROL_GEOFENCE_SWEEP, () => this.watch(), {
      intervalMs: WATCH_INTERVAL_MS,
    });
  }

  /** The run's version's fence; null when it has none. */
  async fenceOf(tx: TenantTxClient, run: PatrolRun): Promise<Geofence | null> {
    const version = await tx.patrolRouteVersion.findUnique({
      where: { id: run.versionId },
      select: { geofence: true },
    });
    return geofenceOf(version?.geofence);
  }

  /**
   * Walks a batch's new points (after every point walked before, in time
   * order). The caller holds the run FOR UPDATE.
   */
  async walk(
    tx: TenantTxClient,
    run: PatrolRun,
    fence: Geofence,
    points: readonly WalkedPoint[],
  ): Promise<void> {
    const guardId = run.guardAccountId;
    if (!points.length || !guardId) return;
    const open = await tx.patrolGeofenceExit.findFirst({
      where: { runId: run.id, backAt: null },
    });
    const spans = walkExits(
      open ? { leftAt: open.leftAt } : null,
      points.map((p) => ({ at: p.recordedAt, outside: isOutside(fence, p) })),
    );
    const minutes = (await this.settings.read(tx)).geofenceExitMinutes;
    for (const span of spans) {
      let id: string;
      if (open && span.leftAt.getTime() === open.leftAt.getTime()) {
        id = open.id;
        if (span.backAt)
          await tx.patrolGeofenceExit.update({
            where: { id },
            data: { backAt: span.backAt },
          });
      } else {
        id = newId();
        await tx.patrolGeofenceExit.create({
          data: {
            id,
            tenantId: run.tenantId,
            runId: run.id,
            guardAccountId: guardId,
            leftAt: span.leftAt,
            backAt: span.backAt,
          },
        });
      }
      if (exitLasted(span, minutes * MINUTE))
        await this.flag(tx, id, run, minutes);
    }
  }

  /** A run's exits, oldest first. */
  exits(tx: TenantTxClient, runId: string): Promise<PatrolGeofenceExit[]> {
    return tx.patrolGeofenceExit.findMany({
      where: { runId },
      orderBy: [{ leftAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Open exits nobody flagged, past the threshold by now (or by their
   * run's end), compound by compound. A run another writer holds is left
   * for the next pass (SKIP LOCKED); under its lock the exit is read again.
   */
  private watch(): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const minutes = (await this.settings.read(tx)).geofenceExitMinutes;
      const at = await dbNow(tx);
      const since = new Date(at.getTime() - SWEEP_LOOKBACK_HOURS * 60 * MINUTE);
      const due = await tx.$queryRaw<{ id: string; run_id: string }[]>`
        SELECT x.id, x.run_id FROM patrol_geofence_exits x
          JOIN patrol_runs r ON r.tenant_id = x.tenant_id AND r.id = x.run_id
         WHERE x.back_at IS NULL AND x.flagged_at IS NULL
           AND x.left_at > ${since}
           AND x.left_at + make_interval(mins => ${minutes}::int)
               <= LEAST(${at}::timestamptz, COALESCE(r.ended_at, ${at}::timestamptz))
         ORDER BY x.left_at, x.id`;
      let flagged = 0;
      for (const d of due) {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM patrol_runs WHERE id = ${d.run_id}::uuid
             FOR UPDATE SKIP LOCKED`;
        if (!locked.length) continue;
        const exit = await tx.patrolGeofenceExit.findUnique({
          where: { id: d.id },
        });
        if (!exit || exit.backAt || exit.flaggedAt) continue;
        const run = await tx.patrolRun.findUniqueOrThrow({
          where: { id: d.run_id },
        });
        if (await this.flag(tx, exit.id, run, minutes)) flagged++;
      }
      return flagged;
    });
  }

  /** Flags an exit once and tells the keepers; whether it was this call. */
  private async flag(
    tx: TenantTxClient,
    exitId: string,
    run: PatrolRun,
    minutes: number,
  ): Promise<boolean> {
    const { count } = await tx.patrolGeofenceExit.updateMany({
      where: { id: exitId, flaggedAt: null },
      data: { flaggedAt: await dbNow(tx), flaggedMinutes: minutes },
    });
    if (!count) return false;
    await this.safety.notify(
      tx,
      await this.safety.holding(tx, 'patrols.manage'),
      'patrol.geofence_exit',
      run.id,
      { minutes },
      run.guardAccountId,
    );
    await this.controlRoom.publish(tx, {
      kind: 'patrol_geofence_exit',
      source: { type: 'patrol_geofence_exit', id: exitId },
      gateId: run.gateId,
      placeId: run.placeId,
      shiftId: run.shiftId,
    });
    return true;
  }
}
