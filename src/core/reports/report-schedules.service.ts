import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ReportRun, ReportSchedule } from '@prisma/client';
import { Readable } from 'node:stream';
import { PermissionsService } from '../access/permissions.service';
import { StaffRecipients } from '../access/staff-recipients';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import { localDate, type LocalDate } from '../common/slots/day-slots';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { FilesService } from '../files/files.service';
import {
  ObjectStorage,
  objectKey,
  type PresignedRead,
} from '../files/object-storage';
import { Notifier } from '../notifications/notifier';
import { SweepRunner } from '../sweep/sweep-runner';
import {
  cadencePeriod,
  type ReportCadence,
  type ReportComparison,
  type ReportFormat,
} from './report-periods';
import { StaffReports, type ReportPeriod } from './report-registry';
import { groupingOf, ReportsService } from './reports.service';

export const REPORT_SCHEDULES_SWEEP = 'reports.schedules';
export const REPORT_RUNS_EXPIRE_SWEEP = 'reports.runs_expire';
/** Every 15 minutes: a period's run comes within 15 minutes of its end. */
export const REPORT_SCHEDULES_EVERY_MS = 15 * 60_000;
/** A run's file is kept this many days, then deleted. */
export const REPORT_RUN_KEEP_DAYS = 90;
/** Schedules one compound may keep, paused ones counted. */
export const REPORT_SCHEDULES_MAX = 50;

const PAGE = keysetCursor('writtenAt', 'desc');

const scheduleNotFound = () =>
  appError.notFound(
    ErrorCode.REPORT_SCHEDULE_NOT_FOUND,
    'Report schedule not found',
  );
const runNotFound = () =>
  appError.notFound(ErrorCode.REPORT_RUN_NOT_FOUND, 'Report not found');

export interface NewSchedule {
  reportKey: string;
  cadence: ReportCadence;
  format: ReportFormat;
  compare?: ReportComparison;
  groupBy?: string;
}

export interface ScheduleChange {
  format?: ReportFormat;
  compare?: ReportComparison;
  groupBy?: string;
  active?: boolean;
}

interface Due {
  scheduleId: string;
  period: ReportPeriod;
}

/**
 * Scheduled reports (ADR 0086). A schedule is made by a holder of
 * `reports.schedule` who may read its report; the sweep, every 15 minutes,
 * writes each active schedule's run once per period — the last whole day,
 * week (Saturday to Friday) or month before the compound's today, never an
 * older one and never one that ended before the schedule was made — in a
 * transaction of its own, as the system:
 *
 * - the period's lock first (an advisory lock on schedule and period), then
 *   whether its run exists: two sweeps at once wait for each other, and the
 *   second finds the first's run and writes nothing. The unique key
 *   (tenant, schedule, period) backs it;
 * - the report read and drawn in that transaction, its file uploaded to the
 *   private bucket and attached as a `report_file`, the run written;
 * - the staff who hold the report's permission then are told, with the
 *   report's key and period only. Each downloads the file with their own
 *   session, holding the permission when they do.
 *
 * A failure rolls the transaction back and deletes the uploaded object; the
 * next sweep tries again while the period is the last one. A run's file is
 * kept 90 days, then the run expires and its file goes.
 */
@Injectable()
export class ReportSchedulesService implements OnModuleInit {
  private readonly logger = new Logger(ReportSchedulesService.name);

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly registry: StaffReports,
    private readonly reports: ReportsService,
    private readonly permissions: PermissionsService,
    private readonly recipients: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly storage: ObjectStorage,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(REPORT_SCHEDULES_SWEEP, (now) => this.run(now), {
      intervalMs: REPORT_SCHEDULES_EVERY_MS,
    });
    this.sweep.register(REPORT_RUNS_EXPIRE_SWEEP, (now) => this.expireDue(now));
  }

  // --------------------------------------------------------------------------
  // Schedules
  // --------------------------------------------------------------------------

  list(): Promise<ReportSchedule[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.reportSchedule.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  async create(input: NewSchedule): Promise<ReportSchedule> {
    const def = await this.reports.readable(input.reportKey);
    return this.tenantTx.withTenantTx(async (tx) => {
      // The compound's schedules counted under one lock: two at once wait.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`report-schedules:${this.ctx.txTenantId}`}))`;
      const count = await tx.reportSchedule.count();
      if (count >= REPORT_SCHEDULES_MAX)
        throw appError.conflict(
          ErrorCode.REPORT_SCHEDULES_FULL,
          'The compound has as many schedules as it may',
          { params: { max: REPORT_SCHEDULES_MAX } },
        );
      const { now } = await this.reports.clock(tx);
      const compare = input.compare ?? 'none';
      const groupBy = groupingOf(def, input.groupBy);
      const row = await tx.reportSchedule.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          reportKey: def.key,
          cadence: input.cadence,
          format: input.format,
          compare,
          groupBy,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'report_schedule.created',
        targetId: row.id,
        metadata: {
          reportKey: row.reportKey,
          cadence: row.cadence,
          format: row.format,
          compare: row.compare,
          groupBy: row.groupBy,
        },
      });
      return row;
    });
  }

  async update(id: string, change: ScheduleChange): Promise<ReportSchedule> {
    const seen = await this.tenantTx.withTenantTx((tx) =>
      tx.reportSchedule.findUnique({ where: { id } }),
    );
    if (!seen) throw scheduleNotFound();
    const def = await this.reports.readable(seen.reportKey);
    if (change.groupBy !== undefined) groupingOf(def, change.groupBy);
    return this.tenantTx.withTenantTx(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM report_schedules WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw scheduleNotFound();
      const row = await tx.reportSchedule.update({
        where: { id },
        data: {
          ...(change.format !== undefined ? { format: change.format } : {}),
          ...(change.compare !== undefined ? { compare: change.compare } : {}),
          ...(change.groupBy !== undefined ? { groupBy: change.groupBy } : {}),
          ...(change.active !== undefined ? { active: change.active } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'report_schedule.changed',
        targetId: id,
        metadata: {
          format: row.format,
          compare: row.compare,
          groupBy: row.groupBy,
          active: row.active,
        },
      });
      return row;
    });
  }

  // --------------------------------------------------------------------------
  // Runs
  // --------------------------------------------------------------------------

  /** The runs of the reports the caller may read, newest first. */
  async runs(q: {
    scheduleId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ReportRun>> {
    const keys = (await this.reports.catalog()).map((r) => r.key);
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.reportRun.findMany({
        where: {
          AND: [
            { reportKey: { in: keys } },
            q.scheduleId ? { scheduleId: q.scheduleId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  /**
   * A presigned GET for a ready run's file (no-store), to a holder of its
   * report's permission now: a run of a report the caller may not read is
   * not found to them. Audited.
   */
  async download(id: string): Promise<PresignedRead> {
    const held = await this.permissions.current();
    return this.tenantTx.withTenantTx(async (tx) => {
      const run = await tx.reportRun.findUnique({ where: { id } });
      const def = run ? this.registry.get(run.reportKey) : null;
      if (!run || !def || !held.has(def.permission)) throw runNotFound();
      if (run.status !== 'ready' || !run.fileId) throw runNotFound();
      const url = await this.storage.presignGet(
        objectKey({ tenantId: run.tenantId, id: run.fileId }),
        {
          downloadName: `${run.reportKey.replace(/_/g, '-')}-${day(run.periodFrom)}-${day(run.periodTo)}.${run.format}`,
        },
      );
      await this.audit.record(tx, {
        action: 'report_run.downloaded',
        targetId: id,
        metadata: { reportKey: run.reportKey },
      });
      return url;
    });
  }

  // --------------------------------------------------------------------------
  // The sweeps
  // --------------------------------------------------------------------------

  /** Every compound's due runs, each in a transaction of its own. */
  run(now: Date): Promise<number> {
    return this.sweep.forEachTenantItem(
      (tx, tenantId) => this.due(tx, tenantId),
      (tx, tenantId, one) => this.write(tx, tenantId, one),
    );
  }

  /** One compound's due runs in the caller's transaction (the suites'). */
  async runIn(tx: TenantTxClient, tenantId: string): Promise<number> {
    let written = 0;
    for (const one of await this.due(tx, tenantId))
      written += await this.write(tx, tenantId, one);
    return written;
  }

  /**
   * The active schedules' last whole periods with no run yet: not in a
   * suspended compound, never a period that ended before the schedule was
   * made.
   */
  private async due(tx: TenantTxClient, tenantId: string): Promise<Due[]> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant?.status !== 'active') return [];
    const schedules = await tx.reportSchedule.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!schedules.length) return [];
    const { today, timeZone } = await this.reports.clock(tx, tenantId);
    const out: Due[] = [];
    for (const s of schedules) {
      const period = cadencePeriod(s.cadence as ReportCadence, today);
      // A period that ended before the compound's day the schedule was
      // made is not sent late.
      if (period.to < localDate(s.createdAt, timeZone)) continue;
      const done = await tx.reportRun.count({
        where: { scheduleId: s.id, periodFrom: dateColumn(period.from) },
      });
      if (!done) out.push({ scheduleId: s.id, period });
    }
    return out;
  }

  /**
   * One run, once: the period's lock, the run looked for again, then the
   * report drawn, uploaded and attached, the run written and its readers
   * told. Returns 1 when this call wrote it.
   */
  private async write(
    tx: TenantTxClient,
    tenantId: string,
    one: Due,
  ): Promise<number> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`report-run:${one.scheduleId}:${one.period.from}`}))`;
    const schedule = await tx.reportSchedule.findUnique({
      where: { id: one.scheduleId },
    });
    if (!schedule?.active) return 0;
    if (
      await tx.reportRun.count({
        where: {
          scheduleId: schedule.id,
          periodFrom: dateColumn(one.period.from),
        },
      })
    )
      return 0;
    const def = this.registry.get(schedule.reportKey);
    if (!def) return 0;
    const { now, today, timeZone } = await this.reports.clock(tx, tenantId);
    const result = await this.reports.build(tx, def, {
      period: one.period,
      groupBy: schedule.groupBy,
      compare: schedule.compare as ReportComparison,
      today,
      timeZone,
    });
    const file = await this.reports.render(
      result,
      schedule.format as ReportFormat,
      await this.reports.compoundName(tx, tenantId),
      now,
    );
    const fileId = newId();
    const key = objectKey({ tenantId, id: fileId });
    await this.storage.putStream(
      key,
      file.contentType,
      Readable.from([file.body]),
    );
    try {
      await tx.storedFile.create({
        data: {
          id: fileId,
          tenantId,
          ownerAccountId: null,
          purpose: 'report_file',
          contentType: file.contentType,
          sizeBytes: file.body.length,
          status: 'ready',
          uploadExpiresAt: now,
          finalizedAt: now,
          attachedAt: now,
        },
      });
      const written = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO report_runs (id, tenant_id, schedule_id, report_key, period_from, period_to,
                                 format, rows, status, file_id, written_at, expires_at)
        VALUES (${newId()}::uuid, ${tenantId}::uuid, ${schedule.id}::uuid, ${schedule.reportKey},
                ${one.period.from}::date, ${one.period.to}::date, ${schedule.format},
                ${result.rows.length}, 'ready', ${fileId}::uuid, ${now},
                ${now}::timestamptz + make_interval(days => ${REPORT_RUN_KEEP_DAYS}))
        ON CONFLICT (tenant_id, schedule_id, period_from) DO NOTHING
        RETURNING id`;
      // Never, under the period's lock: if it were, the whole item rolls back.
      if (!written.length) throw new RunExistsError();
      const runId = written[0].id;
      await this.audit.record(tx, {
        action: 'report_run.written',
        targetId: runId,
        metadata: {
          scheduleId: schedule.id,
          reportKey: schedule.reportKey,
          from: one.period.from,
          to: one.period.to,
          format: schedule.format,
          rows: result.rows.length,
        },
      });
      const to = (await this.recipients.holding(tx, def.permission)).map(
        (r) => r.id,
      );
      await this.notifier.notify(tx, to, {
        kind: 'report_run.ready',
        params: {
          reportKey: schedule.reportKey,
          periodFrom: one.period.from,
          periodTo: one.period.to,
        },
        targetId: runId,
      });
      return 1;
    } catch (error) {
      // The transaction rolls back: the object it uploaded goes with it.
      await this.storage.delete(key).catch(() => undefined);
      this.logger.error(
        `report run failed (${error instanceof Error ? error.name : 'Error'})`,
      );
      throw error;
    }
  }

  /** Runs past their 90 days: expired, their files deleted by the files sweep. */
  async expireDue(now: Date = new Date()): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.$queryRaw<{ id: string; file_id: string }[]>`
        SELECT id, file_id FROM report_runs
         WHERE status = 'ready' AND expires_at <= ${now}
         ORDER BY expires_at LIMIT 200
           FOR UPDATE SKIP LOCKED`;
      for (const r of due) {
        await tx.reportRun.update({
          where: { id: r.id },
          data: { status: 'expired', fileId: null, expiredAt: now },
        });
        await this.files.markDeleted(
          tx,
          { id: r.file_id, purpose: 'report_file' },
          'retention',
        );
        await this.audit.record(tx, {
          action: 'report_run.expired',
          targetId: r.id,
          metadata: {},
        });
      }
      return due.length;
    });
  }
}

/** The run was written by someone else meanwhile: nothing to do. */
class RunExistsError extends Error {
  constructor() {
    super('The period has its run');
    this.name = 'RunExistsError';
  }
}

const dateColumn = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
