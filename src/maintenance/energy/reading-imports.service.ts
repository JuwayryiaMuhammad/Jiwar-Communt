import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { MeterReadingImport, StoredFile } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  CsvRefused,
  parseCsv,
  type ParsedCsv,
} from '../../core/common/csv-parse';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { dateColumn, ofDateColumn } from '../schedules/local-dates';
import { TicketAccess } from '../tickets/ticket-access';
import type { MeterMode } from './meter-rules';
import {
  checkAgainstMeters,
  MAX_READING_PROBLEMS,
  parseReadingSheet,
  sheetMeterCodes,
  type ReadingProblem,
  type SheetMeter,
  type SheetReading,
} from './reading-import-rules';
import { ReadingsService } from './readings.service';

export const READING_IMPORT_RESOURCE = 'meter_reading_import';

const PAGE = keysetCursor('createdAt', 'desc');
const importNotFound = () =>
  appError.notFound(
    ErrorCode.METER_READING_IMPORT_NOT_FOUND,
    'Import not found',
  );

/**
 * A sheet of meter readings (ADR 0066), in two steps, like the asset
 * register's (ADR 0064). Uploading it checks it whole and records what is
 * wrong (`{ line, field, code }`, never a cell's text). Applying a valid
 * one takes the caller's account FOR SHARE, the import FOR UPDATE, then
 * its meters FOR UPDATE in code order — so no reading of theirs lands in
 * between — checks it again against their live readings, and writes every
 * row or none: what changed since (a day taken, a meter retired) makes it
 * invalid instead. Applied once.
 */
@Injectable()
export class MeterReadingImportsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly readings: ReadingsService,
    private readonly calendar: CompoundCalendar,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(READING_IMPORT_RESOURCE, (id) => this.get(id));
  }

  list(q: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<MeterReadingImport>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.meterReadingImport.findMany({
        where: { AND: [...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<MeterReadingImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.meterReadingImport.findUnique({ where: { id } });
      if (!row) throw importNotFound();
      return row;
    });
  }

  check(fileId: string): Promise<MeterReadingImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: READING_IMPORT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const file = await this.files.claim(tx, fileId, 'data_import');
      if (!file)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid import',
          {
            fields: [
              { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
            ],
          },
        );
      await this.files.attach(tx, file);
      const sheet = await this.read(file);
      const { problems } = await this.checkSheet(tx, sheet, false);
      const created = await tx.meterReadingImport.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          fileId: file.id,
          status: problems.length ? 'invalid' : 'valid',
          rowCount: sheet.rows.length,
          errorCount: problems.length,
          errors: kept(problems),
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'meter_reading_import.checked',
        targetId: id,
        metadata: {
          fileId: file.id,
          rowCount: created.rowCount,
          errorCount: created.errorCount,
        },
      });
      return created;
    });
  }

  /** Applies a valid import, once; checked again first, under the meters' locks. */
  apply(id: string): Promise<MeterReadingImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM meter_reading_imports WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.meterReadingImport.findUnique({ where: { id } });
      if (!row) throw importNotFound();
      if (row.status !== 'valid')
        throw appError.conflict(
          ErrorCode.METER_READING_IMPORT_NOT_VALID,
          'Only a valid import is applied, once',
          { params: { status: row.status } },
        );
      const file = await tx.storedFile.findUniqueOrThrow({
        where: { id: row.fileId },
      });
      const sheet = await this.read(file);
      const { rows, problems, meters } = await this.checkSheet(tx, sheet, true);
      if (problems.length) {
        const invalid = await tx.meterReadingImport.update({
          where: { id },
          data: {
            status: 'invalid',
            errorCount: problems.length,
            errors: kept(problems),
          },
        });
        await this.audit.record(tx, {
          action: 'meter_reading_import.checked',
          targetId: id,
          metadata: {
            fileId: file.id,
            rowCount: row.rowCount,
            errorCount: problems.length,
          },
        });
        return invalid;
      }
      // By meter, oldest first: each row is the meter's latest as it lands.
      const ordered = [...rows].sort((a, b) =>
        a.meterCode === b.meterCode
          ? a.readOn < b.readOn
            ? -1
            : 1
          : a.meterCode < b.meterCode
            ? -1
            : 1,
      );
      for (const r of ordered) {
        const meter = meters.get(r.meterCode)!;
        await this.readings.insert(tx, meter, newId(), r, {
          source: 'import',
          importId: id,
        });
      }
      const applied = await tx.meterReadingImport.update({
        where: { id },
        data: {
          status: 'applied',
          appliedAt: await dbNow(tx),
          appliedById: this.ctx.accountId,
          appliedCount: rows.length,
        },
      });
      await this.audit.record(tx, {
        action: 'meter_reading_import.applied',
        targetId: id,
        metadata: { created: rows.length },
      });
      return applied;
    });
  }

  /**
   * The sheet's rows and problems. Applying (`lock`), its meters are taken
   * FOR UPDATE in code order before their readings are read.
   */
  private async checkSheet(
    tx: TenantTxClient,
    sheet: ParsedCsv,
    lock: boolean,
  ) {
    const { today } = await this.calendar.now(tx);
    const parsed = parseReadingSheet(sheet, today);
    const codes = sheetMeterCodes(sheet);
    if (lock && codes.length)
      await tx.$queryRaw`SELECT id FROM meters WHERE code = ANY(${codes}::text[]) ORDER BY code FOR UPDATE`;
    const meterRows = codes.length
      ? await tx.meter.findMany({ where: { code: { in: codes } } })
      : [];
    const meters = new Map(meterRows.map((m) => [m.code, m]));
    const sheetMeters = new Map<string, SheetMeter>();
    for (const m of meterRows)
      sheetMeters.set(m.code, {
        id: m.id,
        active: m.active,
        mode: m.mode as MeterMode,
        live: await this.liveAround(
          tx,
          m.id,
          parsed.rows.filter((r) => r.meterCode === m.code),
        ),
      });
    const problems: ReadingProblem[] = [
      ...parsed.problems,
      ...checkAgainstMeters(parsed.rows, sheetMeters),
    ].sort((a, b) => a.line - b.line);
    return { rows: parsed.rows, problems, meters };
  }

  /**
   * A meter's live readings from the one before the sheet's first day to
   * the one after its last: all a row is checked against.
   */
  private async liveAround(
    tx: TenantTxClient,
    meterId: string,
    rows: readonly SheetReading[],
  ) {
    if (!rows.length) return [];
    const days = rows.map((r) => r.readOn).sort();
    const first = days[0];
    const last = days[days.length - 1];
    const live = { meterId, supersededAt: null };
    const before = await tx.meterReading.findFirst({
      where: { ...live, readOn: { lt: dateColumn(first) } },
      orderBy: { readOn: 'desc' },
    });
    const within = await tx.meterReading.findMany({
      where: {
        ...live,
        readOn: { gte: dateColumn(first), lte: dateColumn(last) },
      },
      orderBy: { readOn: 'asc' },
    });
    const after = await tx.meterReading.findFirst({
      where: { ...live, readOn: { gt: dateColumn(last) } },
      orderBy: { readOn: 'asc' },
    });
    return [
      ...(before ? [before] : []),
      ...within,
      ...(after ? [after] : []),
    ].map((r) => ({
      id: r.id,
      readOn: ofDateColumn(r.readOn),
      value: r.value,
      reset: r.reset,
    }));
  }

  /** The sheet, parsed; refused whole when it is not clean CSV (422). */
  private async read(
    file: Pick<StoredFile, 'id' | 'tenantId' | 'sizeBytes'>,
  ): Promise<ParsedCsv> {
    const bytes = await this.files.contents(file);
    if (!bytes)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'The sheet is gone',
        {
          fields: [
            { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ],
        },
      );
    try {
      return parseCsv(bytes);
    } catch (error) {
      if (!(error instanceof CsvRefused)) throw error;
      throw appError.unprocessable(
        ErrorCode.METER_READING_IMPORT_UNREADABLE,
        'The sheet is not CSV a spreadsheet would write',
        {
          params: {
            problem: error.problem,
            ...(error.line === null ? {} : { line: error.line }),
          },
        },
      );
    }
  }
}

const kept = (problems: ReadingProblem[]) =>
  problems.slice(0, MAX_READING_PROBLEMS).map((p) => ({ ...p }));
