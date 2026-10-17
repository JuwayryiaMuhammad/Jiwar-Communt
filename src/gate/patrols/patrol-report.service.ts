import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { DutyNamesReader } from '../roster/duty-names';
import { RosterCore } from '../roster/roster-core';
import { PostView } from '../roster/views/roster.views';
import type {
  PatrolReportRouteView,
  PatrolReportView,
} from './views/report.views';

/**
 * The patrol report (ADR 0052): per route, over the compound's days asked
 * (31 at most), the runs planned then — scheduled, unscheduled, done, late,
 * missed, incomplete, cancelled — their scans by hand, flagged and
 * received after the run ended, and how long a completed run took on
 * average. Two fixed aggregate queries, never one per route.
 */
@Injectable()
export class PatrolReportService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly roster: RosterCore,
    private readonly names: DutyNamesReader,
  ) {}

  build(q: {
    from?: string;
    to?: string;
    routeId?: string;
  }): Promise<PatrolReportView> {
    return this.tenantTx.withTenantTx((tx) => this.report(tx, q));
  }

  private async report(
    tx: TenantTxClient,
    q: { from?: string; to?: string; routeId?: string },
  ): Promise<PatrolReportView> {
    const period = await this.roster.period(tx, q, { back: 6, span: 6 });
    const onlyRoute = q.routeId
      ? Prisma.sql`AND route_id = ${q.routeId}::uuid`
      : Prisma.empty;
    const runs = await tx.$queryRaw<
      {
        route_id: string;
        scheduled: number;
        adhoc: number;
        done: number;
        late: number;
        missed: number;
        incomplete: number;
        cancelled: number;
        avg_minutes: number | null;
      }[]
    >`
      SELECT route_id,
             count(*) FILTER (WHERE kind = 'scheduled' AND status <> 'cancelled')::int AS scheduled,
             count(*) FILTER (WHERE kind = 'adhoc')::int AS adhoc,
             count(*) FILTER (WHERE status = 'completed')::int AS done,
             count(*) FILTER (WHERE late_at IS NOT NULL)::int AS late,
             count(*) FILTER (WHERE status = 'missed')::int AS missed,
             count(*) FILTER (WHERE status IN ('incomplete', 'timed_out'))::int AS incomplete,
             count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
             round(avg(extract(epoch FROM ended_at - started_at) / 60)
                   FILTER (WHERE status = 'completed'))::int AS avg_minutes
        FROM patrol_runs
       WHERE planned_at >= ${period.start} AND planned_at < ${period.end}
             ${onlyRoute}
       GROUP BY route_id`;
    const scans = await tx.$queryRaw<
      { route_id: string; manual: number; suspect: number; late: number }[]
    >`
      SELECT r.route_id,
             count(*) FILTER (WHERE s.method = 'manual')::int AS manual,
             count(*) FILTER (WHERE s.position_suspect)::int AS suspect,
             count(*) FILTER (WHERE r.ended_at IS NOT NULL
                                AND s.received_at > r.ended_at)::int AS late
        FROM patrol_scans s JOIN patrol_runs r ON r.id = s.run_id
       WHERE r.planned_at >= ${period.start} AND r.planned_at < ${period.end}
             ${q.routeId ? Prisma.sql`AND r.route_id = ${q.routeId}::uuid` : Prisma.empty}
       GROUP BY r.route_id`;
    const scansOf = new Map(scans.map((r) => [r.route_id, r]));
    const routes = runs.length
      ? await tx.patrolRoute.findMany({
          where: { id: { in: runs.map((r) => r.route_id) } },
        })
      : [];
    const byId = new Map(routes.map((r) => [r.id, r]));
    const names = await this.names.read(tx, [], routes);
    const rows: PatrolReportRouteView[] = runs
      .map((r) => {
        const route = byId.get(r.route_id)!;
        const sc = scansOf.get(r.route_id);
        return {
          route: { id: route.id, nameEn: route.nameEn, nameAr: route.nameAr },
          post: PostView.of(route, names),
          scheduled: r.scheduled,
          adhoc: r.adhoc,
          done: r.done,
          late: r.late,
          missed: r.missed,
          incomplete: r.incomplete,
          cancelled: r.cancelled,
          manualScans: sc?.manual ?? 0,
          suspectScans: sc?.suspect ?? 0,
          lateScans: sc?.late ?? 0,
          avgMinutes: r.avg_minutes,
        };
      })
      .sort(
        (a, b) =>
          a.route.nameEn.localeCompare(b.route.nameEn) ||
          a.route.id.localeCompare(b.route.id),
      );
    return { from: period.from, to: period.to, routes: rows };
  }
}
