import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { StoredFile, UnitImport } from '@prisma/client';
import { AccountWriter } from '../../core/accounts/account-writer';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { normalizeEmail, normalizePhone } from '../../core/auth/identifier';
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
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { ResidentsService } from '../residents/residents.service';
import { lockUnits } from './unit-lock';
import { registerFacts } from './units.service';
import {
  checkResidentSheet,
  checkUnitSheet,
  columnValues,
  MAX_IMPORT_PROBLEMS,
  MAX_ROWS,
  type ImportProblem,
  type ResidentRow,
  type UnitImportKind,
  type UnitRow,
} from './unit-import-rules';

export const UNIT_IMPORT_RESOURCE = 'unit_import';
export const UNIT_IMPORTS_SWEEP = 'units.imports';
/** A valid import is applied within a day of its upload, or expires. */
export const UNIT_IMPORT_TTL_MS = 24 * 3_600_000;
const SWEEP_BATCH = 100;

const PAGE = keysetCursor('createdAt', 'desc');
const importNotFound = () =>
  appError.notFound(ErrorCode.UNIT_IMPORT_NOT_FOUND, 'Import not found');

type Checked =
  | { kind: 'units'; rows: UnitRow[]; problems: ImportProblem[] }
  | { kind: 'residents'; rows: ResidentRow[]; problems: ImportProblem[] };

/**
 * Sheets of units and of residents (ADR 0072), in two steps as asset
 * sheets (ADR 0064). Uploading checks the sheet whole and records what is
 * wrong: valid or invalid. Applying a valid one, within a day, checks it
 * again under the import's row lock and the units' locks, and creates
 * every row in one transaction, or none: what changed in between (a code
 * taken, an email used) makes it invalid instead. Applied once.
 *
 * A residents sheet holds people's details: its file is let go (marked
 * deleted, then purged by the files' sweep) as soon as the import can no
 * longer be applied — found invalid, applied, or expired. No email goes
 * out: the people imported are told nothing until the management invites
 * them.
 */
@Injectable()
export class UnitImportsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
    private readonly writer: AccountWriter,
    private readonly residents: ResidentsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(UNIT_IMPORT_RESOURCE, (id) => this.get(id));
    this.sweep.register(UNIT_IMPORTS_SWEEP, (now) => this.expire(now));
  }

  list(q: { cursor?: string; limit?: number }): Promise<Page<UnitImport>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.unitImport.findMany({
        where: { AND: [...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<UnitImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.unitImport.findUnique({ where: { id } });
      if (!row) throw importNotFound();
      return row;
    });
  }

  check(kind: UnitImportKind, fileId: string): Promise<UnitImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: UNIT_IMPORT_RESOURCE, id });
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
      const sheet = await this.read(file, kind);
      const { problems } = await this.checkSheet(tx, kind, sheet);
      const keeps = kind === 'units' || problems.length === 0;
      const created = await tx.unitImport.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          kind,
          fileId: keeps ? file.id : null,
          status: problems.length ? 'invalid' : 'valid',
          rowCount: sheet.rows.length,
          errorCount: problems.length,
          errors: kept(problems),
          createdById: this.ctx.accountId,
          createdAt: await dbNow(tx),
        },
      });
      if (!keeps) await this.files.markDeleted(tx, file, 'unused');
      await this.audit.record(tx, {
        action: 'unit_import.checked',
        targetId: id,
        metadata: {
          kind,
          rowCount: created.rowCount,
          errorCount: created.errorCount,
        },
      });
      return created;
    });
  }

  /**
   * Applies a valid import of the last day, once; checked again first. A
   * sheet that no longer holds becomes invalid, with its problems, and
   * nothing is created: the answer says which (`status`).
   */
  apply(id: string): Promise<UnitImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM unit_imports WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.unitImport.findUnique({ where: { id } });
      if (!row) throw importNotFound();
      const now = await dbNow(tx);
      if (
        row.status !== 'valid' ||
        now.getTime() - row.createdAt.getTime() > UNIT_IMPORT_TTL_MS
      )
        throw appError.conflict(
          ErrorCode.UNIT_IMPORT_NOT_VALID,
          'Only a valid import is applied, once, within a day',
          {
            params: {
              status: row.status === 'valid' ? 'expired' : row.status,
            },
          },
        );
      const kind = row.kind as UnitImportKind;
      const file = await tx.storedFile.findUniqueOrThrow({
        where: { id: row.fileId! },
      });
      const sheet = await this.read(file, kind);
      const checked = await this.checkSheet(tx, kind, sheet, { lock: true });
      if (checked.problems.length) {
        const invalid = await tx.unitImport.update({
          where: { id },
          data: {
            status: 'invalid',
            errorCount: checked.problems.length,
            errors: kept(checked.problems),
            ...(kind === 'residents' ? { fileId: null } : {}),
          },
        });
        if (kind === 'residents')
          await this.files.markDeleted(tx, file, 'unused');
        await this.audit.record(tx, {
          action: 'unit_import.checked',
          targetId: id,
          metadata: {
            kind,
            rowCount: row.rowCount,
            errorCount: checked.problems.length,
          },
        });
        return invalid;
      }
      const created =
        checked.kind === 'units'
          ? await this.createUnits(tx, checked.rows)
          : await this.createResidents(tx, checked.rows);
      const applied = await tx.unitImport.update({
        where: { id },
        data: {
          status: 'applied',
          appliedAt: now,
          appliedById: this.ctx.accountId,
          appliedCount: created,
          ...(kind === 'residents' ? { fileId: null } : {}),
        },
      });
      if (kind === 'residents') await this.files.markDeleted(tx, file, 'read');
      await this.audit.record(tx, {
        action: 'unit_import.applied',
        targetId: id,
        metadata: { kind, created },
      });
      return applied;
    });
  }

  /**
   * The sweep: valid imports over a day old expire, each under its row
   * lock (SKIP LOCKED: one being applied is left for the next run); a
   * residents sheet's file goes with it.
   */
  expire(now: Date): Promise<number> {
    const before = new Date(now.getTime() - UNIT_IMPORT_TTL_MS);
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.$queryRaw<
        { id: string; kind: string; file_id: string | null }[]
      >`
        SELECT id, kind, file_id FROM unit_imports
         WHERE status = 'valid' AND created_at < ${before}
         ORDER BY created_at LIMIT ${SWEEP_BATCH}
         FOR UPDATE SKIP LOCKED`;
      for (const d of due) {
        const residents = d.kind === 'residents';
        await tx.unitImport.update({
          where: { id: d.id },
          data: { status: 'expired', ...(residents ? { fileId: null } : {}) },
        });
        if (residents && d.file_id)
          await this.files.markDeleted(
            tx,
            { id: d.file_id, purpose: 'data_import' },
            'retention',
          );
        await this.audit.record(tx, {
          action: 'unit_import.expired',
          targetId: d.id,
          metadata: { kind: d.kind },
        });
      }
      return due.length;
    });
  }

  private async createUnits(
    tx: TenantTxClient,
    rows: UnitRow[],
  ): Promise<number> {
    for (const r of rows) {
      const unit = await tx.unit.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          code: r.code,
          building: r.building,
          floor: r.floor,
          unitType: r.unitType,
          areaSqm: r.areaSqm,
        },
      });
      await this.audit.record(tx, {
        action: 'unit.created',
        targetId: unit.id,
        changes: diffChanges(
          null,
          { code: unit.code, ...registerFacts(unit) },
          'unit.created',
        ),
        metadata: { imported: true },
      });
    }
    return rows.length;
  }

  /**
   * Each row an account (no email: AccountWriter sends none) and its place,
   * the units locked first in one order, as every occupancy write does.
   */
  private async createResidents(
    tx: TenantTxClient,
    rows: ResidentRow[],
  ): Promise<number> {
    await lockUnits(
      tx,
      rows.map((r) => r.unitId),
    );
    for (const r of rows) {
      const account = await this.writer.create(tx, this.ctx.tenantId, {
        type: 'resident',
        fullName: r.fullName,
        phone: r.phone,
        email: r.email,
        idDocumentType: r.idDocumentType,
        idDocumentNumber: r.idDocumentNumber,
        nationality: r.nationality,
        birthDate: r.birthDate,
        preferredLocale: r.preferredLocale,
      });
      await this.residents.occupyIn(tx, {
        accountId: account.id,
        unitId: r.unitId,
        occupancyType: r.occupancyType,
        resides: r.occupancyType === 'tenant' ? true : r.resides !== false,
      });
    }
    return rows.length;
  }

  private async checkSheet(
    tx: TenantTxClient,
    kind: UnitImportKind,
    sheet: ParsedCsv,
    opts: { lock?: boolean } = {},
  ): Promise<Checked> {
    if (kind === 'units') {
      const codes = columnValues(sheet, 'code');
      const existing = codes.length
        ? await tx.unit.findMany({
            where: { code: { in: codes } },
            select: { code: true },
          })
        : [];
      return {
        kind,
        ...checkUnitSheet(sheet, {
          existingCodes: new Set(existing.map((u) => u.code)),
        }),
      };
    }
    const codes = [...new Set(columnValues(sheet, 'unit'))];
    if (opts.lock && codes.length)
      await tx.$queryRaw`SELECT id FROM units WHERE code = ANY(${codes}::text[]) ORDER BY id FOR NO KEY UPDATE`;
    const units = codes.length
      ? await tx.unit.findMany({
          where: { code: { in: codes } },
          select: { id: true, code: true },
        })
      : [];
    const emails = columnValues(sheet, 'email')
      .map(normalizeEmail)
      .filter((e): e is string => e !== null);
    const phones = columnValues(sheet, 'phone')
      .map(normalizePhone)
      .filter((p): p is string => p !== null);
    const taken = await tx.account.findMany({
      where: {
        type: 'resident',
        OR: [{ email: { in: emails } }, { phone: { in: phones } }],
      },
      select: { email: true, phone: true },
    });
    return {
      kind,
      ...checkResidentSheet(sheet, {
        units: new Map(units.map((u) => [u.code, u.id])),
        takenEmails: new Set(
          taken.map((a) => a.email).filter((e): e is string => e !== null),
        ),
        takenPhones: new Set(
          taken.map((a) => a.phone).filter((p): p is string => p !== null),
        ),
      }),
    };
  }

  /** The sheet, parsed; refused whole when it is not clean CSV (422). */
  private async read(
    file: Pick<StoredFile, 'id' | 'tenantId' | 'sizeBytes'>,
    kind: UnitImportKind,
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
      return parseCsv(bytes, {
        maxBytes: 1024 * 1024,
        maxRows: MAX_ROWS[kind],
      });
    } catch (error) {
      if (!(error instanceof CsvRefused)) throw error;
      throw appError.unprocessable(
        ErrorCode.UNIT_IMPORT_UNREADABLE,
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

const kept = (problems: ImportProblem[]) =>
  problems.slice(0, MAX_IMPORT_PROBLEMS).map((p) => ({ ...p }));
