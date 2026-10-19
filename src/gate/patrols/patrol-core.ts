import { Injectable } from '@nestjs/common';
import type {
  PatrolCheckpoint,
  PatrolRoute,
  PatrolRouteVersion,
  PatrolRun,
  PatrolScan,
} from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedReadView } from '../../core/files/views/file.views';
import { GateMedia, type MediaView } from '../media/gate-media';
import { DutyNamesReader } from '../roster/duty-names';
import type { RouteContext } from './views/route.views';
import type { RunContext } from './views/run.views';

export const routeNotFound = () =>
  appError.notFound(ErrorCode.PATROL_ROUTE_NOT_FOUND, 'Route not found');
export const routeRetired = () =>
  appError.conflict(ErrorCode.PATROL_ROUTE_RETIRED, 'The route is retired');

/**
 * What the patrol services share (ADR 0052): the route's row lock, its
 * current version, a version's checkpoints in order, and the names the
 * views need.
 *
 * **Lock order**, everywhere: the account (FOR SHARE) → the shift → the
 * route → the run → the checkpoint. A new version takes the route FOR
 * UPDATE, then its checkpoints FOR SHARE in id order, then the scheduled
 * runs it replaces FOR UPDATE; a scan takes a checkpoint FOR SHARE only,
 * a reissue or a retirement the checkpoint alone: no cycle.
 */
@Injectable()
export class PatrolCore {
  constructor(
    private readonly names: DutyNamesReader,
    private readonly files: FilesService,
    private readonly media: GateMedia,
  ) {}

  /** The route FOR UPDATE, or 404. */
  async lockRoute(tx: TenantTxClient, id: string): Promise<PatrolRoute> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patrol_routes WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw routeNotFound();
    return tx.patrolRoute.findUniqueOrThrow({ where: { id } });
  }

  /** The route FOR SHARE (a new version waits), or null. */
  async shareRoute(
    tx: TenantTxClient,
    id: string,
  ): Promise<PatrolRoute | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patrol_routes WHERE id = ${id}::uuid FOR SHARE`;
    return row ? tx.patrolRoute.findUniqueOrThrow({ where: { id } }) : null;
  }

  currentVersion(
    tx: TenantTxClient,
    routeId: string,
  ): Promise<PatrolRouteVersion> {
    return tx.patrolRouteVersion.findFirstOrThrow({
      where: { routeId, supersededAt: null },
    });
  }

  /** Per version: its checkpoints in the order walked. */
  async stops(
    tx: TenantTxClient,
    versionIds: readonly string[],
  ): Promise<Map<string, PatrolCheckpoint[]>> {
    const ids = [...new Set(versionIds)];
    const links = ids.length
      ? await tx.patrolRouteCheckpoint.findMany({
          where: { versionId: { in: ids } },
          orderBy: [{ versionId: 'asc' }, { position: 'asc' }],
        })
      : [];
    const checkpoints = links.length
      ? await tx.patrolCheckpoint.findMany({
          where: { id: { in: [...new Set(links.map((l) => l.checkpointId))] } },
        })
      : [];
    const byId = new Map(checkpoints.map((c) => [c.id, c]));
    const out = new Map<string, PatrolCheckpoint[]>();
    for (const l of links)
      out.set(l.versionId, [
        ...(out.get(l.versionId) ?? []),
        byId.get(l.checkpointId)!,
      ]);
    return out;
  }

  /** What route views need: names, each route's current version, its stops. */
  async routeContext(
    tx: TenantTxClient,
    routes: readonly PatrolRoute[],
  ): Promise<RouteContext> {
    const versions = routes.length
      ? await tx.patrolRouteVersion.findMany({
          where: {
            routeId: { in: routes.map((r) => r.id) },
            supersededAt: null,
          },
        })
      : [];
    return {
      names: await this.names.read(tx, [], routes),
      versions: new Map(versions.map((v) => [v.routeId, v])),
      stops: await this.stops(
        tx,
        versions.map((v) => v.id),
      ),
    };
  }

  /**
   * What run views need: names, routes, versions and their stops, the scan
   * counts; for a detail, the scans and notes too, and the photos' read
   * URLs (only of `photosOf`'s notes when given: a guard sees their own).
   */
  async runContext(
    tx: TenantTxClient,
    runs: readonly PatrolRun[],
    detail: { photosOf?: string } | false = false,
  ): Promise<RunContext> {
    const routeIds = [...new Set(runs.map((r) => r.routeId))];
    const versionIds = [...new Set(runs.map((r) => r.versionId))];
    const routes = routeIds.length
      ? await tx.patrolRoute.findMany({ where: { id: { in: routeIds } } })
      : [];
    const versions = versionIds.length
      ? await tx.patrolRouteVersion.findMany({
          where: { id: { in: versionIds } },
        })
      : [];
    const runIds = runs.map((r) => r.id);
    const counts = runIds.length
      ? await tx.$queryRaw<
          { run_id: string; manual: number; suspect: number; late: number }[]
        >`
          SELECT s.run_id,
                 count(*) FILTER (WHERE s.method = 'manual')::int AS manual,
                 count(*) FILTER (WHERE s.position_suspect)::int AS suspect,
                 count(*) FILTER (WHERE r.ended_at IS NOT NULL
                                    AND s.received_at > r.ended_at)::int AS late
            FROM patrol_scans s JOIN patrol_runs r ON r.id = s.run_id
           WHERE s.run_id = ANY(${runIds}::uuid[])
           GROUP BY s.run_id`
      : [];
    const scans =
      detail && runIds.length
        ? await tx.patrolScan.findMany({
            where: { runId: { in: runIds } },
            orderBy: [{ position: 'asc' }],
          })
        : [];
    const notes = scans.length
      ? await tx.patrolNote.findMany({
          where: { scanId: { in: scans.map((sc) => sc.id) } },
        })
      : [];
    const shown = notes.filter(
      (n) =>
        detail && (!detail.photosOf || n.guardAccountId === detail.photosOf),
    );
    const photoRows = shown.length
      ? await tx.patrolNotePhoto.findMany({
          where: { noteId: { in: shown.map((n) => n.id) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const photos = new Map<string, PresignedReadView[]>();
    for (const p of photoRows) {
      const url = await this.files.readUrl(tx, p.fileId);
      if (url) photos.set(p.noteId, [...(photos.get(p.noteId) ?? []), url]);
    }
    const media = new Map<string, MediaView[]>();
    if (shown.length) {
      const rows = await tx.patrolNoteMedia.findMany({
        where: { noteId: { in: shown.map((n) => n.id) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const n of shown) {
        const own = rows.filter((m) => m.noteId === n.id);
        if (own.length) media.set(n.id, await this.media.views(tx, own));
      }
    }
    const scansByRun = new Map<string, PatrolScan[]>();
    for (const sc of scans)
      scansByRun.set(sc.runId, [...(scansByRun.get(sc.runId) ?? []), sc]);
    return {
      names: await this.names.read(
        tx,
        runs.flatMap((r) => [r.guardAccountId, r.cancelledById]),
        runs,
      ),
      routes: new Map(routes.map((r) => [r.id, r])),
      versions: new Map(versions.map((v) => [v.id, v])),
      stops: await this.stops(tx, versionIds),
      counts: new Map(
        counts.map((c) => [
          c.run_id,
          { manual: c.manual, suspect: c.suspect, late: c.late },
        ]),
      ),
      scans: scansByRun,
      notes: new Map(notes.map((n) => [n.scanId, n])),
      photos,
      media,
    };
  }

  /** Whether a post is in service: a gate active, or a zone not retired. */
  async inService(
    tx: TenantTxClient,
    post: { gateId: string | null; placeId: string | null },
  ): Promise<boolean> {
    if (post.gateId)
      return (
        (await tx.gate.count({
          where: { id: post.gateId, status: 'active' },
        })) > 0
      );
    return (
      (await tx.place.count({ where: { id: post.placeId!, active: true } })) > 0
    );
  }
}
