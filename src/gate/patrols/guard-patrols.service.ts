import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type PatrolRun } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { localDate } from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { midnight, RosterCore } from '../roster/roster-core';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService, type DutyShift } from '../shifts/shifts.service';
import { PatrolCore } from './patrol-core';
import {
  BOARD_AHEAD_HOURS,
  endStatus,
  lateAfter,
  startProblem,
} from './patrol-rules';
import { RunsCore } from './runs-core';
import {
  GuardRunDetailView,
  GuardRunView,
  type PatrolBoardView,
} from './views/run.views';

/** A run as its starter is answered, for the replay of a start. */
export const GUARD_RUN_RESOURCE = 'patrol_run_guard';
const CURSOR = keysetCursor('plannedAt');
const HOUR = 3_600_000;

export const runNotFound = () =>
  appError.notFound(ErrorCode.PATROL_RUN_NOT_FOUND, 'Run not found');
const alreadyLive = () =>
  appError.conflict(
    ErrorCode.PATROL_RUN_ALREADY_LIVE,
    'Another run of yours is under way',
  );

const atPost = (
  run: { gateId: string | null; placeId: string | null },
  duty: DutyShift | null,
) =>
  duty !== null &&
  (run.gateId ? run.gateId === duty.gateId : run.placeId === duty.placeId);

/**
 * The guard's side of patrols (ADR 0052), with `gate.operate`. A guard on
 * shift sees their post's runs and routes, starts a scheduled run there
 * (the first wins: PATROL_ALREADY_STARTED) or one of their own, and ends
 * their run under way. One run under way per guard.
 *
 * **Lock order** of a start: the guard's account FOR SHARE (a deactivation
 * holds it FOR UPDATE first), their open shift FOR SHARE (its end waits,
 * or the start finds it ended), the route FOR SHARE (a new version waits,
 * or the start finds its run cancelled), then the run FOR UPDATE. Every
 * rule is decided under them by the database's clock.
 */
@Injectable()
export class GuardPatrolsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly roster: RosterCore,
    private readonly core: PatrolCore,
    private readonly runs: RunsCore,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(GUARD_RUN_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.detailOf(
          tx,
          await tx.patrolRun.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /** On shift: my run under way, my post's runs and routes. */
  board(): Promise<PatrolBoardView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const duty = await this.shifts.requireOnDuty(tx);
      const now = await dbNow(tx);
      const dayStart = midnight(
        localDate(now, await this.roster.timeZone(tx)),
        await this.roster.timeZone(tx),
      );
      const post = duty.gateId
        ? { gateId: duty.gateId }
        : { placeId: duty.placeId! };
      const live = await tx.patrolRun.findFirst({
        where: { guardAccountId: this.ctx.accountId, status: 'in_progress' },
      });
      const runs = await tx.patrolRun.findMany({
        where: {
          ...post,
          OR: [
            {
              status: 'scheduled',
              windowEndsAt: { gt: now },
              scheduledStart: {
                lte: new Date(now.getTime() + BOARD_AHEAD_HOURS * HOUR),
              },
            },
            { startedAt: { gte: dayStart } },
          ],
        },
        orderBy: [{ plannedAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      const routes = await tx.patrolRoute.findMany({
        where: { ...post, retiredAt: null },
        orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
      });
      const routeContext = await this.core.routeContext(tx, routes);
      const c = await this.core.runContext(tx, live ? [live, ...runs] : runs, {
        photosOf: this.ctx.accountId,
      });
      return {
        live: live
          ? GuardRunDetailView.forViewer(live, c, this.ctx.accountId)
          : null,
        runs: runs.map((r) => GuardRunView.from(r, c)),
        routes: routes.map((r) => {
          const v = routeContext.versions.get(r.id)!;
          return {
            id: r.id,
            nameEn: r.nameEn,
            nameAr: r.nameAr,
            ordered: v.ordered,
            expectedMinutes: v.expectedMinutes,
            checkpoints: routeContext.stops.get(v.id)?.length ?? 0,
          };
        }),
      };
    });
  }

  /** The runs I started, newest first. */
  mine(q: { cursor?: string; limit: number }): Promise<Page<GuardRunView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.patrolRun.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            { guardAccountId: this.ctx.accountId },
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      const c = await this.core.runContext(tx, page.items);
      return {
        items: page.items.map((r) => GuardRunView.from(r, c)),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** A run of mine, or of the post where I am on shift. */
  detail(id: string): Promise<GuardRunDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await tx.patrolRun.findUnique({ where: { id } });
      if (!run) throw runNotFound();
      if (run.guardAccountId !== this.ctx.accountId) {
        const duty = await this.shifts.onDuty(tx, this.ctx.accountId);
        if (!atPost(run, duty)) throw runNotFound();
      }
      return this.detailOf(tx, run);
    });
  }

  /**
   * A scheduled run at my post, from 15 minutes before its start until
   * its window ends. The first start wins (PATROL_ALREADY_STARTED).
   * `Idempotency-Key`: a retry replays the same run.
   */
  start(id: string): Promise<GuardRunDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const duty = await this.lockDuty(tx);
      const seen = await tx.patrolRun.findUnique({ where: { id } });
      if (!seen || !atPost(seen, duty)) throw runNotFound();
      await this.core.shareRoute(tx, seen.routeId);
      const run = (await this.runs.lockRun(tx, id))!;
      if (run.kind !== 'scheduled' || run.startedAt)
        throw appError.conflict(
          ErrorCode.PATROL_ALREADY_STARTED,
          'Someone started this run first',
        );
      const now = await dbNow(tx);
      const problem =
        run.status === 'cancelled' || run.status === 'missed'
          ? run.status
          : startProblem(
              {
                scheduledStart: run.scheduledStart!,
                windowEndsAt: run.windowEndsAt!,
              },
              now,
            );
      if (problem)
        throw appError.conflict(
          ErrorCode.PATROL_RUN_NOT_STARTABLE,
          'This run cannot be started now',
          { params: { reason: problem } },
        );
      await this.requireNoLiveRun(tx);
      await this.idempotency.claim(tx, { type: GUARD_RUN_RESOURCE, id });
      const late =
        now >=
        lateAfter({
          scheduledStart: run.scheduledStart!,
          createdAt: run.createdAt,
        });
      const started = await this.updateStarted(tx, id, {
        status: 'in_progress',
        guardAccountId: this.ctx.accountId,
        shiftId: duty.id,
        startedAt: now,
        // Started late without the sweep's look: marked late here, once.
        lateAt: run.lateAt ?? (late ? now : null),
      });
      await this.audit.record(tx, {
        action: 'patrol_run.started',
        targetId: id,
        metadata: { kind: 'scheduled', shiftId: duty.id, late },
      });
      return this.detailOf(tx, started);
    });
  }

  /**
   * A run of my own, of a route in service from my post, on its current
   * version. `Idempotency-Key`.
   */
  startAdhoc(routeId: string): Promise<GuardRunDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const duty = await this.lockDuty(tx);
      const route = await this.core.shareRoute(tx, routeId);
      if (!route || route.retiredAt || !atPost(route, duty))
        throw appError.notFound(
          ErrorCode.PATROL_ROUTE_NOT_FOUND,
          'Route not found',
        );
      await this.requireNoLiveRun(tx);
      const id = newId();
      await this.idempotency.claim(tx, { type: GUARD_RUN_RESOURCE, id });
      const version = await this.core.currentVersion(tx, routeId);
      const now = await dbNow(tx);
      let run: PatrolRun;
      try {
        run = await tx.patrolRun.create({
          data: {
            id,
            tenantId: this.ctx.txTenantId,
            routeId,
            versionId: version.id,
            gateId: route.gateId,
            placeId: route.placeId,
            kind: 'adhoc',
            plannedAt: now,
            status: 'in_progress',
            guardAccountId: this.ctx.accountId,
            shiftId: duty.id,
            startedAt: now,
            checkpointsTotal: await tx.patrolRouteCheckpoint.count({
              where: { versionId: version.id },
            }),
          },
        });
      } catch (error) {
        throw this.liveRace(error);
      }
      await this.audit.record(tx, {
        action: 'patrol_run.started',
        targetId: id,
        metadata: { kind: 'adhoc', shiftId: duty.id, late: false },
      });
      return this.detailOf(tx, run);
    });
  }

  /**
   * My run under way, ended now: completed when every checkpoint was
   * scanned (the last scan completes it anyway), else incomplete, and the
   * roster's keepers are told.
   */
  end(id: string): Promise<GuardRunDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await this.runs.lockRun(tx, id);
      if (!run || run.guardAccountId !== this.ctx.accountId)
        throw runNotFound();
      if (run.status !== 'in_progress')
        throw appError.conflict(
          ErrorCode.PATROL_RUN_NOT_LIVE,
          'The run is not under way',
          { params: { status: run.status } },
        );
      const ended = await this.runs.end(
        tx,
        run,
        endStatus(run.scannedCount, run.checkpointsTotal) === 'completed'
          ? 'completed'
          : 'guard',
        await dbNow(tx),
      );
      return this.detailOf(tx, ended);
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** My account FOR SHARE, then my open shift FOR SHARE: 403 NO_OPEN_SHIFT. */
  private async lockDuty(tx: TenantTxClient): Promise<DutyShift> {
    await this.safety.lockSelf(tx);
    const duty = await this.shifts.requireOnDuty(tx);
    const [open] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM guard_shifts
       WHERE id = ${duty.id}::uuid AND ended_at IS NULL FOR SHARE`;
    if (!open) return this.shifts.requireOnDuty(tx);
    return duty;
  }

  private async requireNoLiveRun(tx: TenantTxClient): Promise<void> {
    const live = await tx.patrolRun.count({
      where: { guardAccountId: this.ctx.accountId, status: 'in_progress' },
    });
    if (live) throw alreadyLive();
  }

  private async updateStarted(
    tx: TenantTxClient,
    id: string,
    data: Prisma.PatrolRunUpdateInput,
  ): Promise<PatrolRun> {
    try {
      return await tx.patrolRun.update({ where: { id }, data });
    } catch (error) {
      throw this.liveRace(error);
    }
  }

  /** Two starts of mine at once: the partial unique index decides. */
  private liveRace(error: unknown): unknown {
    return error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
      ? alreadyLive()
      : error;
  }

  private async detailOf(
    tx: TenantTxClient,
    run: PatrolRun,
  ): Promise<GuardRunDetailView> {
    return GuardRunDetailView.forViewer(
      run,
      await this.core.runContext(tx, [run], { photosOf: this.ctx.accountId }),
      this.ctx.accountId,
    );
  }
}
