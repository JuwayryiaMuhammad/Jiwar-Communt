import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AssetImport, StoredFile } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
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
import { TicketAccess } from '../tickets/ticket-access';
import {
  checkAssetSheet,
  MAX_IMPORT_PROBLEMS,
  referencedCodes,
  type ImportLookups,
  type ImportProblem,
} from './asset-import-rules';
import { AssetsService } from './assets.service';

export const ASSET_IMPORT_RESOURCE = 'asset_import';

const PAGE = keysetCursor('createdAt', 'desc');
const importNotFound = () =>
  appError.notFound(ErrorCode.ASSET_IMPORT_NOT_FOUND, 'Import not found');

/**
 * An asset sheet (ADR 0064), in two steps. Uploading it checks it whole
 * and records what is wrong (`{ line, field, code }`, never a cell's
 * text): valid or invalid. Applying a valid one checks it again, under
 * the locks the inserts need (the places and the parents it names, shared),
 * and then creates every row in one transaction, or none: what changed in
 * between (a code taken, an area retired) makes it invalid instead. Applied
 * once, under the import's row lock.
 *
 * The file is the import's from the upload on (attached, never served
 * back); a sheet a spreadsheet would not write is refused at the upload
 * (422 ASSET_IMPORT_UNREADABLE), with no import left behind.
 */
@Injectable()
export class AssetImportsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly assets: AssetsService,
    private readonly community: CommunityMaintenancePort,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(ASSET_IMPORT_RESOURCE, (id) => this.get(id));
  }

  list(q: { cursor?: string; limit?: number }): Promise<Page<AssetImport>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.assetImport.findMany({
        where: { AND: [...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<AssetImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.assetImport.findUnique({ where: { id } });
      if (!row) throw importNotFound();
      return row;
    });
  }

  check(fileId: string): Promise<AssetImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: ASSET_IMPORT_RESOURCE, id });
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
      const { problems } = checkAssetSheet(
        sheet,
        await this.lookups(tx, sheet),
      );
      const created = await tx.assetImport.create({
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
        action: 'asset_import.checked',
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

  /**
   * Applies a valid import, once; checked again first. A sheet that no
   * longer holds becomes invalid, with its problems, and nothing is
   * created: the answer says which (`status`).
   */
  apply(id: string): Promise<AssetImport> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM asset_imports WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.assetImport.findUnique({ where: { id } });
      if (!row) throw importNotFound();
      if (row.status !== 'valid')
        throw appError.conflict(
          ErrorCode.ASSET_IMPORT_NOT_VALID,
          'Only a valid import is applied, once',
          { params: { status: row.status } },
        );
      const file = await tx.storedFile.findUniqueOrThrow({
        where: { id: row.fileId },
      });
      const sheet = await this.read(file);
      const { rows, problems } = checkAssetSheet(
        sheet,
        await this.lookups(tx, sheet, { lock: true }),
      );
      if (problems.length) {
        const invalid = await tx.assetImport.update({
          where: { id },
          data: {
            status: 'invalid',
            errorCount: problems.length,
            errors: kept(problems),
          },
        });
        await this.audit.record(tx, {
          action: 'asset_import.checked',
          targetId: id,
          metadata: {
            fileId: file.id,
            rowCount: row.rowCount,
            errorCount: problems.length,
          },
        });
        return invalid;
      }
      const ids = new Map<string, string>();
      for (const r of rows) {
        const assetId = newId();
        ids.set(r.code, assetId);
        await this.assets.insert(
          tx,
          assetId,
          {
            ...r.facts,
            code: r.code,
            typeId: r.typeId,
            parentId:
              r.parent === null
                ? null
                : 'existingId' in r.parent
                  ? r.parent.existingId
                  : ids.get(r.parent.rowCode)!,
            depth: r.depth,
            unitId: r.unitId,
            commonAreaId: r.commonAreaId,
          },
          'imported',
        );
      }
      const applied = await tx.assetImport.update({
        where: { id },
        data: {
          status: 'applied',
          appliedAt: await dbNow(tx),
          appliedById: this.ctx.accountId,
          appliedCount: rows.length,
        },
      });
      await this.audit.record(tx, {
        action: 'asset_import.applied',
        targetId: id,
        metadata: { created: rows.length },
      });
      return applied;
    });
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
        ErrorCode.ASSET_IMPORT_UNREADABLE,
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

  /**
   * What the sheet's codes are. Applying, the places and the parents it
   * names are shared-locked first, so none is retired or moved under it.
   */
  private async lookups(
    tx: TenantTxClient,
    sheet: ParsedCsv,
    opts: { lock?: boolean } = {},
  ): Promise<ImportLookups> {
    const refs = referencedCodes(sheet);
    if (opts.lock) {
      if (refs.areas.length)
        await tx.$queryRaw`SELECT id FROM common_areas WHERE code = ANY(${refs.areas}::text[]) ORDER BY id FOR SHARE`;
      if (refs.assets.length)
        await tx.$queryRaw`SELECT id FROM assets WHERE code = ANY(${refs.assets}::text[]) ORDER BY id FOR SHARE`;
    }
    const types = await tx.assetType.findMany({
      where: { active: true },
      select: { id: true, key: true },
    });
    const areas = refs.areas.length
      ? await tx.commonArea.findMany({
          where: { code: { in: refs.areas }, active: true },
          select: { id: true, code: true },
        })
      : [];
    const existing = refs.assets.length
      ? await tx.asset.findMany({
          where: { code: { in: refs.assets } },
          select: {
            id: true,
            code: true,
            depth: true,
            unitId: true,
            commonAreaId: true,
            status: true,
          },
        })
      : [];
    return {
      types: new Map(types.map((t) => [t.key, t.id])),
      units: await this.community.unitsByCode(tx, refs.units),
      areas: new Map(areas.map((a) => [a.code, a.id])),
      existing: new Map(
        existing.map((a) => [
          a.code,
          {
            id: a.id,
            depth: a.depth,
            unitId: a.unitId,
            commonAreaId: a.commonAreaId,
            retired: a.status === 'retired',
          },
        ]),
      ),
      buildings: await this.community.existingBuildings(tx, refs.buildings),
    };
  }
}

const kept = (problems: ImportProblem[]) =>
  problems.slice(0, MAX_IMPORT_PROBLEMS).map((p) => ({ ...p }));
