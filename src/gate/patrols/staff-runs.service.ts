import { Injectable } from '@nestjs/common';
import type { PatrolRun, PatrolRunStatus } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { RosterCore } from '../roster/roster-core';
import { runNotFound } from './guard-patrols.service';
import { PatrolCore } from './patrol-core';
import { RunsCore } from './runs-core';
import { RunDetailView, RunView } from './views/run.views';

const CURSOR = keysetCursor('plannedAt');

/**
 * The runs as the management reads them (ADR 0052): with `patrols.manage`
 * or `guard_reports.read`, guards by full name. `patrols.manage` cancels a
 * scheduled run nobody started, under its row lock.
 */
@Injectable()
export class StaffRunsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly roster: RosterCore,
    private readonly core: PatrolCore,
    private readonly runs: RunsCore,
  ) {}

  /** The runs planned on the compound's days `from` … `to` (31 at most), newest first. */
  list(q: {
    from?: string;
    to?: string;
    routeId?: string;
    gateId?: string;
    zoneId?: string;
    status?: PatrolRunStatus;
    guardId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<RunView>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const period = await this.roster.period(tx, q, { back: 6, span: 7 });
      const rows = await tx.patrolRun.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            { plannedAt: { gte: period.start, lt: period.end } },
            ...(q.routeId ? [{ routeId: q.routeId }] : []),
            ...(q.gateId ? [{ gateId: q.gateId }] : []),
            ...(q.zoneId ? [{ placeId: q.zoneId }] : []),
            ...(q.status ? [{ status: q.status }] : []),
            ...(q.guardId ? [{ guardAccountId: q.guardId }] : []),
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      const page = CURSOR.toPage(rows, q.limit);
      const c = await this.core.runContext(tx, page.items);
      return {
        items: page.items.map((r) => RunView.of(r, c)),
        nextCursor: page.nextCursor,
      };
    });
  }

  detail(id: string): Promise<RunDetailView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await tx.patrolRun.findUnique({ where: { id } });
      if (!run) throw runNotFound();
      return this.detailOf(tx, run);
    });
  }

  /**
   * A scheduled run nobody started, cancelled with a `patrolRunCancel`
   * code. The row is taken FOR UPDATE: a start holding it finished first
   * (409 PATROL_RUN_CLOSED), or finds it cancelled.
   */
  cancel(id: string, reasonCode: string | undefined): Promise<RunView> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.patrolRunCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await this.runs.lockRun(tx, id);
      if (!run) throw runNotFound();
      if (run.status !== 'scheduled')
        throw appError.conflict(
          ErrorCode.PATROL_RUN_CLOSED,
          'The run is not scheduled any more',
          { params: { status: run.status } },
        );
      const cancelled = await tx.patrolRun.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelReason: reason,
          cancelledById: this.ctx.accountId,
          endedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'patrol_run.cancelled',
        targetId: id,
        metadata: { reason },
      });
      return RunView.of(cancelled, await this.core.runContext(tx, [cancelled]));
    });
  }

  private async detailOf(
    tx: TenantTxClient,
    run: PatrolRun,
  ): Promise<RunDetailView> {
    return RunDetailView.from(run, await this.core.runContext(tx, [run]));
  }
}
