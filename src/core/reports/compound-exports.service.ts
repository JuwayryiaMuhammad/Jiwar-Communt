import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma, type CompoundExport } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import { StepUpService } from '../auth/step-up.service';
import type { AppClsStore } from '../common/cls/app-cls';
import { RequestContext } from '../common/cls/request-context';
import { csvRows, toCsv } from '../common/csv';
import { appError, ErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { ZipStream } from '../exports/zip-stream';
import { FilesService } from '../files/files.service';
import {
  ObjectStorage,
  objectKey,
  type PresignedRead,
} from '../files/object-storage';
import { FILE_PURPOSES } from '../files/purposes';
import { Notifier } from '../notifications/notifier';
import { RateLimitService } from '../redis/rate-limit.service';
import { SweepRunner } from '../sweep/sweep-runner';
import { EXPORT_TABLES, type ExportTable } from './export-tables';

export const COMPOUND_EXPORT_BUILD_SWEEP = 'compound_exports.build';
export const COMPOUND_EXPORT_EXPIRE_SWEEP = 'compound_exports.expire';

const HOUR = 3_600_000;
/** A ready export can be downloaded this long, then its file is deleted. */
export const COMPOUND_EXPORT_TTL_MS = 7 * 24 * HOUR;
/** At most one request per compound in this window. */
export const COMPOUND_EXPORT_WINDOW_MS = 24 * HOUR;
/** A build's lease; a build that dies is taken again after it. */
export const COMPOUND_EXPORT_LEASE_MS = 15 * 60_000;
export const COMPOUND_EXPORT_MAX_ATTEMPTS = 3;
/** Requests one account may try in an hour, refused ones counted. */
export const COMPOUND_EXPORT_TRIES_PER_HOUR = 5;
/** Rows read per page of a table. */
const PAGE_ROWS = 2000;

/** What the manager sees of an export: no content. */
export interface CompoundExportRead {
  id: string;
  status: string;
  requestedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  tables: number | null;
  rows: number | null;
}

interface Claimed {
  id: string;
  tenantId: string;
  objectId: string;
  attempts: number;
}

const notFound = () =>
  appError.notFound(ErrorCode.COMPOUND_EXPORT_NOT_FOUND, 'Export not found');

/**
 * The compound's export (ADR 0086): its operational data as one zip, a CSV
 * per table of EXPORT_TABLES, with their fixed columns and no person's.
 *
 * - **Request** (`compound.export`): at most five tries an hour per
 *   account (the rate limit), then under the compound's advisory lock one
 *   being prepared at a time (`409 COMPOUND_EXPORT_ACTIVE`) and one a day
 *   (`429 COMPOUND_EXPORT_RATE_LIMITED`, `params.retryAfter`), then the
 *   session's fresh step-up is spent. A partial unique index backs the
 *   "one at a time".
 * - **Build** (sweep `compound_exports.build`, every minute): leased under
 *   SKIP LOCKED, streamed table by table, a page of rows at a time each in
 *   its own tenant transaction, into a multipart upload to the private
 *   bucket; then the file attached, the export ready for 7 days, and who
 *   asked told in the app (no link).
 * - **Download**: a presigned GET in a no-store response, for a holder of
 *   `compound.export`.
 * - **Expiry**: the file is marked deleted and the files sweep removes it.
 * - Every step is audited with ids and counts only.
 */
@Injectable()
export class CompoundExportsService implements OnModuleInit {
  private readonly logger = new Logger(CompoundExportsService.name);

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpService,
    private readonly rateLimit: RateLimitService,
    private readonly storage: ObjectStorage,
    private readonly files: FilesService,
    private readonly notifier: Notifier,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.sweep.register(
      COMPOUND_EXPORT_BUILD_SWEEP,
      (now) => this.buildDue(now),
      { intervalMs: 60_000 },
    );
    this.sweep.register(COMPOUND_EXPORT_EXPIRE_SWEEP, (now) =>
      this.expireDue(now),
    );
  }

  async request(now: Date = new Date()): Promise<CompoundExportRead> {
    await this.rateLimit.consume(
      `compound-export:${this.ctx.accountId}`,
      COMPOUND_EXPORT_TRIES_PER_HOUR,
      3600,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`compound-export:${this.ctx.txTenantId}`}))`;
      if (
        await tx.compoundExport.count({
          where: { status: { in: ['pending', 'building'] } },
        })
      )
        throw appError.conflict(
          ErrorCode.COMPOUND_EXPORT_ACTIVE,
          'An export of the compound is being prepared',
        );
      const last = await tx.compoundExport.findFirst({
        orderBy: { requestedAt: 'desc' },
        select: { requestedAt: true },
      });
      if (
        last &&
        last.requestedAt.getTime() > now.getTime() - COMPOUND_EXPORT_WINDOW_MS
      )
        throw appError.tooManyRequests(
          ErrorCode.COMPOUND_EXPORT_RATE_LIMITED,
          'One export of the compound a day',
          {
            params: {
              retryAfter: new Date(
                last.requestedAt.getTime() + COMPOUND_EXPORT_WINDOW_MS,
              ).toISOString(),
            },
          },
        );
      await this.stepUp.consume(tx, now);
      const row = await tx.compoundExport.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          requestedByAccountId: this.ctx.accountId,
          requestedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'compound_export.requested',
        targetId: row.id,
        metadata: { tables: EXPORT_TABLES.length },
      });
      return read(row);
    });
  }

  /** The compound's latest exports, newest first. */
  latest(): Promise<CompoundExportRead[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      (
        await tx.compoundExport.findMany({
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
          take: 10,
        })
      ).map(read),
    );
  }

  async downloadUrl(
    id: string,
    now: Date = new Date(),
  ): Promise<PresignedRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.compoundExport.findUnique({ where: { id } });
      if (
        !row ||
        row.status !== 'ready' ||
        !row.fileId ||
        !row.expiresAt ||
        row.expiresAt <= now
      )
        throw notFound();
      const url = await this.storage.presignGet(
        objectKey({ tenantId: row.tenantId, id: row.fileId }),
        {
          downloadName: `jiwar-compound-${row.readyAt!.toISOString().slice(0, 10)}.zip`,
        },
      );
      await this.audit.record(tx, {
        action: 'compound_export.downloaded',
        targetId: id,
        metadata: {},
      });
      return url;
    });
  }

  // --------------------------------------------------------------------------
  // The sweeps
  // --------------------------------------------------------------------------

  async buildDue(now: Date = new Date()): Promise<number> {
    const claimed: Claimed[] = [];
    const stale: string[] = [];
    await this.sweep.forEachTenant(async (tx, tenantId) => {
      const rows = await tx.$queryRaw<
        { id: string; attempts: number; object_id: string | null }[]
      >`
        SELECT id, attempts, object_id FROM compound_exports
         WHERE status = 'pending'
            OR (status = 'building' AND locked_until < ${now})
         ORDER BY requested_at, id
         LIMIT 1
           FOR UPDATE SKIP LOCKED`;
      for (const r of rows) {
        if (r.object_id) stale.push(objectKey({ tenantId, id: r.object_id }));
        if (r.attempts >= COMPOUND_EXPORT_MAX_ATTEMPTS) {
          await this.end(tx, r.id, 'failed', 'build_failed', now);
          continue;
        }
        const objectId = newId();
        await tx.compoundExport.update({
          where: { id: r.id },
          data: {
            status: 'building',
            attempts: { increment: 1 },
            lockedUntil: new Date(now.getTime() + COMPOUND_EXPORT_LEASE_MS),
            objectId,
          },
        });
        claimed.push({
          id: r.id,
          tenantId,
          objectId,
          attempts: r.attempts + 1,
        });
      }
      return rows.length;
    });
    for (const key of stale) await this.storage.delete(key);
    for (const c of claimed) await this.buildOne(c);
    return claimed.length;
  }

  async expireDue(now: Date = new Date()): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.$queryRaw<{ id: string; file_id: string }[]>`
        SELECT id, file_id FROM compound_exports
         WHERE status = 'ready' AND expires_at <= ${now}
         ORDER BY expires_at LIMIT 50
           FOR UPDATE SKIP LOCKED`;
      for (const r of due) {
        await this.end(tx, r.id, 'expired', null, now);
        await this.files.markDeleted(
          tx,
          { id: r.file_id, purpose: 'compound_export' },
          'retention',
        );
      }
      return due.length;
    });
  }

  // --------------------------------------------------------------------------

  private async buildOne(c: Claimed): Promise<void> {
    const key = objectKey({ tenantId: c.tenantId, id: c.objectId });
    try {
      const { size, rows } = await this.asSystem(c, () => this.write(key));
      await this.asSystem(c, () =>
        this.tenantTx.withTenantTx((tx) => this.finish(tx, c, size, rows)),
      );
    } catch (error) {
      this.logger.error(
        `compound export ${c.id} failed (${error instanceof Error ? error.name : 'Error'})`,
      );
      await this.storage.delete(key);
      await this.asSystem(c, () =>
        this.tenantTx.withTenantTx(async (tx) => {
          const row = await tx.compoundExport.findUnique({
            where: { id: c.id },
          });
          if (row?.status !== 'building' || row.objectId !== c.objectId) return;
          const tooLarge =
            error instanceof Error && error.name === 'ExportTooLargeError';
          if (c.attempts >= COMPOUND_EXPORT_MAX_ATTEMPTS || tooLarge)
            await this.end(
              tx,
              c.id,
              'failed',
              tooLarge ? 'too_large' : 'build_failed',
              new Date(),
            );
          else
            await tx.compoundExport.update({
              where: { id: c.id },
              data: { status: 'pending', lockedUntil: null },
            });
        }),
      );
    }
  }

  /** The archive, streamed into the store: its size and how many rows. */
  private async write(key: string): Promise<{ size: number; rows: number }> {
    const zip = new ZipStream(FILE_PURPOSES.compound_export.maxBytes);
    const upload = this.storage.putStream(key, 'application/zip', zip.output);
    upload.catch((error: unknown) =>
      zip.output.destroy(error instanceof Error ? error : new Error('upload')),
    );
    let rows = 0;
    try {
      await zip.addJson('README.json', {
        format: 'jiwar-compound-export/1',
        generatedAt: new Date().toISOString(),
        tables: EXPORT_TABLES.map((t) => ({
          file: `${t.file}.csv`,
          columns: t.columns.map((c) => c.name),
        })),
      });
      for (const table of EXPORT_TABLES) {
        const counted = { n: 0 };
        await zip.addChunks(`${table.file}.csv`, this.pages(table, counted));
        rows += counted.n;
      }
      await zip.end();
      await upload;
    } catch (error) {
      zip.output.destroy();
      await upload.catch(() => undefined);
      throw error;
    }
    return { size: zip.bytes, rows };
  }

  /** A table's CSV: its header, then a page of rows by id at a time. */
  private async *pages(
    t: ExportTable,
    counted: { n: number },
  ): AsyncGenerator<Buffer> {
    const csvColumns = t.columns.map((c) => ({
      header: c.name,
      kind: c.kind,
    }));
    yield toCsv(csvColumns, []);
    const select = Prisma.raw(
      t.columns.map((c) => `"${c.name}"::text AS "${c.name}"`).join(', '),
    );
    const from = Prisma.raw(`"${t.table}"`);
    const where = t.where ? Prisma.raw(` AND (${t.where})`) : Prisma.empty;
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page = await this.tenantTx.withTenantTx(
        (tx) =>
          tx.$queryRaw<Record<string, string | null>[]>`
            SELECT id::text AS "__id", ${select} FROM ${from}
             WHERE id > ${after}::uuid${where}
             ORDER BY id LIMIT ${PAGE_ROWS}`,
      );
      if (!page.length) return;
      counted.n += page.length;
      yield csvRows(
        csvColumns,
        page.map((r) => t.columns.map((c) => r[c.name] ?? null)),
      );
      after = page[page.length - 1].__id!;
      if (page.length < PAGE_ROWS) return;
    }
  }

  private async finish(
    tx: TenantTxClient,
    c: Claimed,
    size: number,
    rows: number,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM compound_exports WHERE id = ${c.id}::uuid FOR UPDATE`;
    const row = await tx.compoundExport.findUniqueOrThrow({
      where: { id: c.id },
    });
    if (row.status !== 'building' || row.objectId !== c.objectId)
      throw new Error('The build lost its lease');
    const finished = new Date();
    await tx.storedFile.create({
      data: {
        id: c.objectId,
        tenantId: c.tenantId,
        ownerAccountId: null,
        purpose: 'compound_export',
        contentType: 'application/zip',
        sizeBytes: size,
        status: 'ready',
        uploadExpiresAt: finished,
        finalizedAt: finished,
        attachedAt: finished,
      },
    });
    const expiresAt = new Date(finished.getTime() + COMPOUND_EXPORT_TTL_MS);
    await tx.compoundExport.update({
      where: { id: c.id },
      data: {
        status: 'ready',
        fileId: c.objectId,
        readyAt: finished,
        expiresAt,
        lockedUntil: null,
        tables: EXPORT_TABLES.length,
        rows: BigInt(rows),
      },
    });
    await this.audit.record(tx, {
      action: 'compound_export.ready',
      targetId: c.id,
      metadata: { attempts: c.attempts, tables: EXPORT_TABLES.length, rows },
    });
    await this.notifier.notify(tx, [row.requestedByAccountId], {
      kind: 'compound_export.ready',
      params: { expiresAt: expiresAt.toISOString() },
      targetId: c.id,
    });
  }

  private async end(
    tx: TenantTxClient,
    id: string,
    status: 'expired' | 'failed',
    failureCode: string | null,
    now: Date,
  ): Promise<void> {
    await tx.compoundExport.update({
      where: { id },
      data: {
        status,
        endedAt: now,
        fileId: null,
        lockedUntil: null,
        failureCode: status === 'failed' ? failureCode : null,
      },
    });
    await this.audit.record(tx, {
      action:
        status === 'expired'
          ? 'compound_export.expired'
          : 'compound_export.failed',
      targetId: id,
      metadata: failureCode ? { reasonCode: failureCode } : {},
    });
  }

  /** Runs `fn` in the export's compound as the system: RLS reads its rows. */
  private asSystem<T>(c: Claimed, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set('tenantId', c.tenantId);
      this.cls.set('auditActor', { type: 'system', id: null });
      return await fn();
    });
  }
}

function read(r: CompoundExport): CompoundExportRead {
  return {
    id: r.id,
    status: r.status,
    requestedAt: r.requestedAt,
    readyAt: r.readyAt,
    expiresAt: r.expiresAt,
    tables: r.tables,
    rows: r.rows === null ? null : Number(r.rows),
  };
}
