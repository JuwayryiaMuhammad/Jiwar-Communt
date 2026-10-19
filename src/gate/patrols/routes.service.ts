import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type PatrolRoute,
  type PatrolRouteVersion,
} from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { FieldErrorCode, type FieldError } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { RosterCore } from '../roster/roster-core';
import { checkGeofence, type Geofence } from './geofence';
import { PatrolCore, routeNotFound, routeRetired } from './patrol-core';
import { RunsCore } from './runs-core';
import {
  checkPatrolSchedule,
  ROUTE_CHECKPOINTS,
  type PatrolSchedule,
} from './patrol-rules';
import { RouteDetailView, RouteView } from './views/route.views';

export const ROUTE_RESOURCE = 'patrol_route';
const CURSOR = keysetCursor('createdAt');

/** What a version asks, as given. */
export interface RouteVersionInput {
  checkpointIds: string[];
  ordered: boolean;
  expectedMinutes: number;
  schedule?: PatrolSchedule | null;
  geofence?: { circle?: unknown; polygon?: unknown } | null;
}

/** A version checked: the same, normalized. */
interface CheckedVersion {
  checkpointIds: string[];
  ordered: boolean;
  expectedMinutes: number;
  schedule: PatrolSchedule | null;
  geofence: Geofence | null;
}

/** What the audit sees of a route: its post; its names as changed. */
function audited(r: PatrolRoute) {
  return {
    gateId: r.gateId,
    placeId: r.placeId,
    nameEn: r.nameEn,
    nameAr: r.nameAr,
  };
}

/** What the audit sees of a version: codes and counts. */
const versionMetadata = (v: PatrolRouteVersion, checkpoints: number) => ({
  version: v.number,
  checkpoints,
  ordered: v.ordered,
  expectedMinutes: v.expectedMinutes,
  scheduled: v.schedule !== null,
  // Its kind, never where (ADR 0056).
  ...(v.geofence
    ? { geofence: 'circle' in (v.geofence as object) ? 'circle' : 'polygon' }
    : {}),
});

/**
 * The routes a patrol walks (ADR 0052), kept by `patrols.manage`. A route
 * is walked from a post (a gate, or a zone) and has names; what it asks is
 * a version — its checkpoints in order, whether the order is enforced,
 * how long it takes, its weekly start times. Changing any of it makes a
 * new version under the route's row lock; a run keeps the version it was
 * made with. Two routes in service never share a name. Retired, never
 * deleted.
 */
@Injectable()
export class RoutesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly roster: RosterCore,
    private readonly core: PatrolCore,
    private readonly runs: RunsCore,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(ROUTE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.detailOf(
          tx,
          await tx.patrolRoute.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /** A route and its first version. `Idempotency-Key`. */
  create(input: {
    gateId?: string;
    zoneId?: string;
    nameEn: string;
    nameAr: string;
    version: RouteVersionInput;
  }): Promise<RouteDetailView> {
    const version = this.check(input.version, 'version.');
    return this.tenantTx.withTenantTx(async (tx) => {
      const post = await this.roster.requirePost(tx, input);
      const id = newId();
      await this.idempotency.claim(tx, { type: ROUTE_RESOURCE, id });
      const route = await tx.patrolRoute.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          gateId: post.gateId,
          placeId: post.placeId,
          nameEn: input.nameEn.trim(),
          nameAr: input.nameAr.trim(),
          createdById: this.ctx.accountId,
        },
      });
      const first = await this.writeVersion(tx, route, 1, version, 'version.');
      const made = await this.runs.generate(
        tx,
        route,
        first,
        await dbNow(tx),
        await this.roster.timeZone(tx),
      );
      await this.audit.record(tx, {
        action: 'patrol_route.created',
        targetId: id,
        changes: diffChanges(null, audited(route), 'patrol_route.created'),
        metadata: {
          ...versionMetadata(first, version.checkpointIds.length),
          runs: made,
        },
      });
      return this.detailOf(tx, route);
    });
  }

  /** Names only, while in service: a version keeps everything else. */
  rename(
    id: string,
    input: { nameEn?: string; nameAr?: string },
  ): Promise<RouteDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.core.lockRoute(tx, id);
      if (before.retiredAt) throw routeRetired();
      const route = await tx.patrolRoute.update({
        where: { id },
        data: { nameEn: input.nameEn?.trim(), nameAr: input.nameAr?.trim() },
      });
      const changes = diffChanges(
        audited(before),
        audited(route),
        'patrol_route.renamed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'patrol_route.renamed',
          targetId: id,
          changes,
        });
      return this.detailOf(tx, route);
    });
  }

  /**
   * A new version. Lock order: the route FOR UPDATE, its checkpoints FOR
   * SHARE in id order, then the scheduled runs it replaces FOR UPDATE in
   * id order. The current version is superseded, the runs nobody started
   * are cancelled (`route_changed`) and the new version's are made, all in
   * this transaction. A run under way keeps its version.
   */
  newVersion(id: string, input: RouteVersionInput): Promise<RouteDetailView> {
    const version = this.check(input, '');
    return this.tenantTx.withTenantTx(async (tx) => {
      const route = await this.core.lockRoute(tx, id);
      if (route.retiredAt) throw routeRetired();
      const current = await this.core.currentVersion(tx, id);
      const next = await this.supersede(tx, route, current, version);
      const now = await dbNow(tx);
      const cancelled = await this.runs.cancelScheduled(
        tx,
        id,
        'route_changed',
        now,
      );
      const made = await this.runs.generate(
        tx,
        route,
        next,
        now,
        await this.roster.timeZone(tx),
      );
      await this.audit.record(tx, {
        action: 'patrol_route.versioned',
        targetId: id,
        metadata: {
          ...versionMetadata(next, version.checkpointIds.length),
          cancelledRuns: cancelled,
          runs: made,
        },
      });
      return this.detailOf(tx, route);
    });
  }

  /**
   * Retired once, never brought back: its scheduled runs nobody started are
   * cancelled (`route_retired`); a run under way finishes.
   */
  retire(id: string): Promise<RouteDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.core.lockRoute(tx, id);
      if (before.retiredAt) throw routeRetired();
      const now = await dbNow(tx);
      const route = await tx.patrolRoute.update({
        where: { id },
        data: { retiredAt: now, retiredById: this.ctx.accountId },
      });
      const cancelled = await this.runs.cancelScheduled(
        tx,
        id,
        'route_retired',
        now,
      );
      await this.audit.record(tx, {
        action: 'patrol_route.retired',
        targetId: id,
        metadata: { cancelledRuns: cancelled },
      });
      return this.detailOf(tx, route);
    });
  }

  list(q: {
    status?: 'active' | 'retired';
    gateId?: string;
    zoneId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<RouteView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.patrolRoute.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            ...(q.status === 'active' ? [{ retiredAt: null }] : []),
            ...(q.status === 'retired' ? [{ retiredAt: { not: null } }] : []),
            ...(q.gateId ? [{ gateId: q.gateId }] : []),
            ...(q.zoneId ? [{ placeId: q.zoneId }] : []),
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      const c = await this.core.routeContext(tx, page.items);
      return {
        items: page.items.map((r) => RouteView.of(r, c)),
        nextCursor: page.nextCursor,
      };
    });
  }

  detail(id: string): Promise<RouteDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const route = await tx.patrolRoute.findUnique({ where: { id } });
      if (!route) throw routeNotFound();
      return this.detailOf(tx, route);
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Checks a version's shape before any lock; field names under `prefix`. */
  private check(input: RouteVersionInput, prefix: string): CheckedVersion {
    const fields: FieldError[] = [];
    const ids = input.checkpointIds ?? [];
    if (new Set(ids).size !== ids.length)
      fields.push({
        field: `${prefix}checkpointIds`,
        code: FieldErrorCode.DUPLICATE_VALUE,
      });
    if (
      ids.length < ROUTE_CHECKPOINTS.min ||
      ids.length > ROUTE_CHECKPOINTS.max
    )
      fields.push({
        field: `${prefix}checkpointIds`,
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...ROUTE_CHECKPOINTS },
      });
    const schedule = input.schedule
      ? checkPatrolSchedule(
          input.schedule,
          input.expectedMinutes,
          fields,
          `${prefix}schedule`,
        )
      : null;
    const geofence = input.geofence
      ? checkGeofence(input.geofence, fields, `${prefix}geofence`)
      : null;
    if (fields.length) throw invalid(fields);
    return {
      checkpointIds: ids,
      ordered: input.ordered,
      expectedMinutes: input.expectedMinutes,
      schedule,
      geofence,
    };
  }

  /**
   * Supersedes `current` and writes the next version: the partial unique
   * index keeps one current version per route.
   */
  private async supersede(
    tx: TenantTxClient,
    route: PatrolRoute,
    current: PatrolRouteVersion,
    version: CheckedVersion,
  ): Promise<PatrolRouteVersion> {
    await tx.patrolRouteVersion.update({
      where: { id: current.id },
      data: { supersededAt: await dbNow(tx) },
    });
    return this.writeVersion(tx, route, current.number + 1, version, '');
  }

  /**
   * The version and its stops. Its checkpoints are taken FOR SHARE in id
   * order: a retirement holding one finished first (and it is refused
   * here), or waits and finds it walked (PATROL_CHECKPOINT_IN_USE).
   */
  private async writeVersion(
    tx: TenantTxClient,
    route: PatrolRoute,
    number: number,
    v: CheckedVersion,
    prefix: string,
  ): Promise<PatrolRouteVersion> {
    const rows = await tx.$queryRaw<{ id: string; active: boolean }[]>`
      SELECT id, retired_at IS NULL AS active FROM patrol_checkpoints
       WHERE id = ANY(${[...v.checkpointIds]}::uuid[]) ORDER BY id FOR SHARE`;
    const active = new Set(rows.filter((r) => r.active).map((r) => r.id));
    if (v.checkpointIds.some((id) => !active.has(id)))
      throw invalid([
        {
          field: `${prefix}checkpointIds`,
          code: FieldErrorCode.CHECKPOINT_NOT_AVAILABLE,
        },
      ]);
    const version = await tx.patrolRouteVersion.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        routeId: route.id,
        number,
        ordered: v.ordered,
        expectedMinutes: v.expectedMinutes,
        schedule: v.schedule
          ? (v.schedule as unknown as Prisma.InputJsonValue)
          : undefined,
        geofence: v.geofence
          ? (v.geofence as unknown as Prisma.InputJsonValue)
          : undefined,
        createdById: this.ctx.accountId,
      },
    });
    await tx.patrolRouteCheckpoint.createMany({
      data: v.checkpointIds.map((checkpointId, i) => ({
        id: newId(),
        tenantId: this.ctx.txTenantId,
        versionId: version.id,
        position: i + 1,
        checkpointId,
      })),
    });
    return version;
  }

  private async detailOf(
    tx: TenantTxClient,
    route: PatrolRoute,
  ): Promise<RouteDetailView> {
    return RouteDetailView.from(
      route,
      await this.core.routeContext(tx, [route]),
    );
  }
}
