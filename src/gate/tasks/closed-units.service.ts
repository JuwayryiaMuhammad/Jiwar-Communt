import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClosedUnitRound } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  afterCursor,
  StaffInbox,
  waitingSince,
} from '../../core/staff-inbox/staff-inbox';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { GateSettingsService } from '../settings/gate-settings.service';
import { inspectionReference } from './inspection-requests.service';

export const CLOSED_UNIT_ROUNDS_SWEEP = 'security.closed_unit_rounds';
/** The closed units' list shows this many at most, the longest closed first. */
export const CLOSED_UNITS_MAX = 500;
/** The sweep makes at most this many rounds due in a compound per run. */
const ROUND_BATCH = 200;
const HOUR_MS = 3_600_000;

export const ROUND_STATUSES = [
  'due',
  'scheduled',
  'done',
  'cancelled',
] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];
/** Why a round is cancelled (the CHECK repeats them). */
export type RoundCancel = 'unit_reopened' | 'task_cancelled';

/** A closed unit, as the management's list shows it. */
export interface ClosedUnitRead {
  unitId: string;
  unitCode: string;
  building: string | null;
  closedSince: Date;
  /** The newest closed-unit inspection done since it closed, if any. */
  lastInspection: { taskId: string; doneAt: Date; outcome: string } | null;
  /** An inspection request still open or scheduled (ADR 0063), if any. */
  openRequest: { id: string; reference: string; status: string } | null;
  /** The live round (due or scheduled), if any. */
  round: ClosedUnitRound | null;
  /** The day the next round falls due: the compound's every N days. */
  nextRoundOn: string;
  /** Live (invited or active) proxies (ADR 0063). */
  liveProxies: number;
}

const roundNotFound = () =>
  appError.notFound(
    ErrorCode.CLOSED_UNIT_ROUND_NOT_FOUND,
    'Closed unit round not found',
  );

/**
 * Closed units and their rounds (ADR 0083), the management's
 * (`guard_tasks.manage`). The list shows every unit in closed mode with
 * its last inspection, an open inspection request, its proxies and its
 * round. A round falls due every N days (the compound's
 * `closedUnitRoundDays`, 30 by default) after the unit closed or was last
 * inspected, whichever is later; the hourly sweep makes it due, one live
 * per unit (a partial unique index), never while an inspection task is
 * already open for the unit. A due round waits in the staff inbox
 * (`closed_unit_round`) until the management schedules it as a closed-unit
 * inspection task for a guard, a gate or a zone (TasksService.create with
 * `roundId`). The task's completion makes the round done; its cancellation
 * cancels the round, and the sweep makes a new one due. A unit reopened
 * leaves its due round cancelled (`unit_reopened`).
 *
 * Locks: a round's row (FOR UPDATE), taken by its scheduling, its task's
 * end and the sweep, so two schedulings at once leave one refused.
 */
@Injectable()
export class ClosedUnitsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly community: CommunityGatePort,
    private readonly sweep: SweepRunner,
    private readonly settings: TenantSettingsService,
    private readonly gateSettings: GateSettingsService,
    private readonly inbox: StaffInbox,
  ) {}

  onModuleInit(): void {
    this.sweep.register(CLOSED_UNIT_ROUNDS_SWEEP, (now) => this.run(now), {
      intervalMs: HOUR_MS,
    });
    this.inbox.register({
      type: 'closed_unit_round',
      permission: 'guard_tasks.manage',
      dueHours: 72,
      page: async (tx, q) => {
        const rows = await tx.closedUnitRound.findMany({
          where: {
            AND: [
              { status: 'due' },
              ...waitingSince('createdAt', q.requestedBefore),
              ...afterCursor('createdAt', q.after),
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: q.take,
          select: { id: true, status: true, unitId: true, createdAt: true },
        });
        return rows.map((r) => ({
          type: 'closed_unit_round' as const,
          id: r.id,
          number: null,
          kind: null,
          status: r.status,
          unitId: r.unitId,
          requestedAt: r.createdAt,
          amount: null,
        }));
      },
      count: (tx, before) =>
        tx.closedUnitRound.count({
          where: {
            AND: [{ status: 'due' }, ...waitingSince('createdAt', before)],
          },
        }),
    });
  }

  // --------------------------------------------------------------------------
  // The management's list
  // --------------------------------------------------------------------------

  list(): Promise<ClosedUnitRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const units = await this.community.closedUnits(tx, CLOSED_UNITS_MAX);
      if (!units.length) return [];
      const ids = units.map((u) => u.unitId);
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const { closedUnitRoundDays } = await this.gateSettings.read(tx);
      const done = await tx.guardTask.findMany({
        where: {
          unitId: { in: ids },
          kind: 'closed_unit_inspection',
          status: 'done',
        },
        orderBy: [{ doneAt: 'desc' }, { id: 'desc' }],
        select: { id: true, unitId: true, doneAt: true, outcome: true },
      });
      const requests = await tx.unitInspectionRequest.findMany({
        where: { unitId: { in: ids }, status: { in: ['open', 'scheduled'] } },
        select: { id: true, number: true, unitId: true, status: true },
      });
      const rounds = await tx.closedUnitRound.findMany({
        where: { unitId: { in: ids }, status: { in: ['due', 'scheduled'] } },
      });
      const proxies = await this.community.liveProxies(tx, ids);
      const next = await this.nextRounds(
        tx,
        ids,
        closedUnitRoundDays,
        timezone,
      );
      const out: ClosedUnitRead[] = [];
      for (const u of units) {
        const last = done.find(
          (t) =>
            t.unitId === u.unitId &&
            t.doneAt !== null &&
            t.doneAt.getTime() >= u.closedSince.getTime(),
        );
        const request = requests.find((r) => r.unitId === u.unitId);
        out.push({
          unitId: u.unitId,
          unitCode: u.unitCode,
          building: u.building,
          closedSince: u.closedSince,
          lastInspection: last
            ? { taskId: last.id, doneAt: last.doneAt!, outcome: last.outcome! }
            : null,
          openRequest: request
            ? {
                id: request.id,
                reference: inspectionReference(request.number),
                status: request.status,
              }
            : null,
          round: rounds.find((r) => r.unitId === u.unitId) ?? null,
          nextRoundOn: next.get(u.unitId) ?? '',
          liveProxies: proxies.get(u.unitId) ?? 0,
        });
      }
      return out;
    });
  }

  // --------------------------------------------------------------------------
  // The task's side (TasksService), in its transaction
  // --------------------------------------------------------------------------

  /**
   * A closed-unit inspection task is created for the round: it must be due
   * and of the task's unit. The round's row is locked: two schedulings at
   * once leave one CLOSED_UNIT_ROUND_NOT_DUE.
   */
  async scheduled(
    tx: TenantTxClient,
    roundId: string,
    unitId: string | undefined,
    taskId: string,
  ): Promise<void> {
    const round = await this.lock(tx, roundId);
    if (!round) throw roundNotFound();
    if (round.unitId !== unitId)
      throw invalid([{ field: 'roundId', code: FieldErrorCode.INVALID_VALUE }]);
    if (round.status !== 'due')
      throw appError.conflict(
        ErrorCode.CLOSED_UNIT_ROUND_NOT_DUE,
        'The round is scheduled, done or cancelled already',
        { params: { status: round.status } },
      );
    await tx.closedUnitRound.update({
      where: { id: roundId },
      data: {
        status: 'scheduled',
        taskId,
        scheduledAt: await dbNow(tx),
      },
    });
    await this.audit.record(tx, {
      action: 'closed_unit_round.scheduled',
      targetId: roundId,
      metadata: { unitId: round.unitId, taskId },
    });
  }

  /** The task is done: so is its round, if it has one. */
  async taskDone(tx: TenantTxClient, taskId: string): Promise<void> {
    const round = await this.ofTask(tx, taskId);
    if (!round) return;
    await tx.closedUnitRound.update({
      where: { id: round.id },
      data: { status: 'done', doneAt: await dbNow(tx) },
    });
    await this.audit.record(tx, {
      action: 'closed_unit_round.done',
      targetId: round.id,
      metadata: { unitId: round.unitId, taskId },
    });
  }

  /** The task is cancelled: its round too; the sweep makes a new one due. */
  async taskCancelled(tx: TenantTxClient, taskId: string): Promise<void> {
    const round = await this.ofTask(tx, taskId);
    if (round) await this.cancel(tx, round, 'task_cancelled');
  }

  // --------------------------------------------------------------------------
  // The sweep
  // --------------------------------------------------------------------------

  /**
   * Per compound: due rounds of reopened units cancelled; scheduled rounds
   * whose task ended some other way (its guard left) settled; then a round
   * made due for each closed unit whose N days have passed since it closed
   * or was last inspected, with none live and no inspection task open.
   */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx, tenantId) => {
      let n = 0;
      const reopened = await tx.$queryRaw<{ id: string }[]>`
        SELECT r.id::text AS id FROM closed_unit_rounds r
          JOIN units u ON u.tenant_id = r.tenant_id AND u.id = r.unit_id
         WHERE r.status = 'due' AND u.closed_since IS NULL
         LIMIT ${ROUND_BATCH}`;
      for (const r of reopened) {
        const round = await this.lock(tx, r.id);
        if (round?.status === 'due') {
          await this.cancel(tx, round, 'unit_reopened');
          n++;
        }
      }
      const settled = await tx.$queryRaw<
        { id: string; taskId: string; taskStatus: string }[]
      >`
        SELECT r.id, r.task_id::text AS "taskId", t.status::text AS "taskStatus"
          FROM closed_unit_rounds r
          JOIN guard_tasks t ON t.tenant_id = r.tenant_id AND t.id = r.task_id
         WHERE r.status = 'scheduled' AND t.status IN ('done', 'cancelled')
         LIMIT ${ROUND_BATCH}`;
      for (const s of settled) {
        if (s.taskStatus === 'done') await this.taskDone(tx, s.taskId);
        else await this.taskCancelled(tx, s.taskId);
        n++;
      }
      const { timezone } = await this.settings.inTx(tx, tenantId);
      const { closedUnitRoundDays } = await this.gateSettings.read(tx);
      const dueUnits = await tx.$queryRaw<{ unitId: string; dueOn: string }[]>`
        SELECT u.id::text AS "unitId",
               to_char(b.base + ${closedUnitRoundDays}::int, 'YYYY-MM-DD') AS "dueOn"
          FROM units u
          CROSS JOIN LATERAL (
            SELECT GREATEST(
              (u.closed_since AT TIME ZONE ${timezone})::date,
              COALESCE((
                SELECT MAX((t.done_at AT TIME ZONE ${timezone})::date)
                  FROM guard_tasks t
                 WHERE t.tenant_id = u.tenant_id AND t.unit_id = u.id
                   AND t.kind = 'closed_unit_inspection' AND t.status = 'done'
                   AND t.done_at >= u.closed_since), '-infinity'::date)) AS base
          ) b
         WHERE u.closed_since IS NOT NULL
           AND b.base + ${closedUnitRoundDays}::int <= (${now}::timestamptz AT TIME ZONE ${timezone})::date
           AND NOT EXISTS (
             SELECT 1 FROM closed_unit_rounds r
              WHERE r.tenant_id = u.tenant_id AND r.unit_id = u.id
                AND r.status IN ('due', 'scheduled'))
           AND NOT EXISTS (
             SELECT 1 FROM guard_tasks t
              WHERE t.tenant_id = u.tenant_id AND t.unit_id = u.id
                AND t.kind = 'closed_unit_inspection'
                AND t.status IN ('open', 'in_progress'))
         ORDER BY u.closed_since, u.id
         LIMIT ${ROUND_BATCH}`;
      for (const d of dueUnits) {
        const id = newId();
        const made = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO closed_unit_rounds
                 (id, tenant_id, unit_id, due_on, status, created_at)
          VALUES (${id}::uuid, ${tenantId}::uuid, ${d.unitId}::uuid, ${d.dueOn}::date,
                  'due', date_trunc('milliseconds', clock_timestamp()))
          ON CONFLICT (tenant_id, unit_id) WHERE status IN ('due', 'scheduled')
          DO NOTHING
          RETURNING id::text AS id`;
        if (!made.length) continue;
        await this.audit.record(tx, {
          action: 'closed_unit_round.due',
          targetId: id,
          metadata: {
            unitId: d.unitId,
            dueOn: d.dueOn,
            everyDays: closedUnitRoundDays,
          },
        });
        n++;
      }
      return n;
    });
  }

  // --------------------------------------------------------------------------

  private async cancel(
    tx: TenantTxClient,
    round: ClosedUnitRound,
    reason: RoundCancel,
  ): Promise<void> {
    await tx.closedUnitRound.update({
      where: { id: round.id },
      data: {
        status: 'cancelled',
        cancelledAt: await dbNow(tx),
        cancelReason: reason,
      },
    });
    await this.audit.record(tx, {
      action: 'closed_unit_round.cancelled',
      targetId: round.id,
      metadata: { unitId: round.unitId, reasonCode: reason },
    });
  }

  private async ofTask(
    tx: TenantTxClient,
    taskId: string,
  ): Promise<ClosedUnitRound | null> {
    const found = await tx.closedUnitRound.findFirst({
      where: { taskId, status: 'scheduled' },
      select: { id: true },
    });
    if (!found) return null;
    const round = await this.lock(tx, found.id);
    return round?.status === 'scheduled' ? round : null;
  }

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<ClosedUnitRound | null> {
    await tx.$queryRaw`SELECT id FROM closed_unit_rounds WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.closedUnitRound.findUnique({ where: { id } });
  }

  /**
   * Each closed unit's next round day: N days after the later of the day
   * it closed and the day it was last inspected since, on the compound's
   * calendar (the sweep's own rule), as YYYY-MM-DD.
   */
  private async nextRounds(
    tx: TenantTxClient,
    unitIds: string[],
    days: number,
    timezone: string,
  ): Promise<Map<string, string>> {
    const rows = await tx.$queryRaw<{ unitId: string; day: string }[]>`
      SELECT u.id::text AS "unitId",
             to_char(GREATEST(
               (u.closed_since AT TIME ZONE ${timezone})::date,
               COALESCE((
                 SELECT MAX((t.done_at AT TIME ZONE ${timezone})::date)
                   FROM guard_tasks t
                  WHERE t.tenant_id = u.tenant_id AND t.unit_id = u.id
                    AND t.kind = 'closed_unit_inspection' AND t.status = 'done'
                    AND t.done_at >= u.closed_since), '-infinity'::date))
               + ${days}::int, 'YYYY-MM-DD') AS day
        FROM units u
       WHERE u.id = ANY(${unitIds}::uuid[]) AND u.closed_since IS NOT NULL`;
    return new Map(rows.map((r) => [r.unitId, r.day]));
  }
}
