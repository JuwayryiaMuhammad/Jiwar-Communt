import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { MaintenanceDocument } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { CommonAreasService } from '../locations/common-areas.service';
import { TicketAccess } from '../tickets/ticket-access';
import type { DocumentKind } from './asset-rules';
import { AssetsService } from './assets.service';
import { assetTypeNotFound } from './asset-types.service';

import { contractNotFound } from '../contracts/contracts.service';

export const DOCUMENT_RESOURCE = 'maintenance_document';
/** Documents one asset, type or area holds at once. */
export const DOCUMENTS_PER_SUBJECT = 50;

export interface DocumentSubject {
  assetId?: string;
  assetTypeId?: string;
  commonAreaId?: string;
  /** ADR 0065: a maintenance contract's papers. */
  contractId?: string;
}

export interface DocumentRead {
  document: MaintenanceDocument;
  read: PresignedRead | null;
}

const documentNotFound = () =>
  appError.notFound(
    ErrorCode.MAINTENANCE_DOCUMENT_NOT_FOUND,
    'Document not found',
  );

/**
 * The register's documents (ADR 0064): plans, manuals, warranty cards, of
 * an asset, an asset type, a common area or a maintenance contract (ADR
 * 0065). Added with `assets.manage`,
 * read by every `assets.read` holder (the technician in the field), each
 * read a presigned URL (no-store). Removed once, never changed: the row
 * stays for the record, its file is deleted.
 *
 * Adding locks the subject's row first (FOR NO KEY UPDATE: a retirement
 * and a parallel add wait), then checks and counts: parallel adds cannot
 * pass the cap, and nothing lands on a retired subject.
 */
@Injectable()
export class DocumentsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly assets: AssetsService,
    private readonly areas: CommonAreasService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(DOCUMENT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const document = await tx.maintenanceDocument.findUniqueOrThrow({
          where: { id },
        });
        return {
          document,
          read: await this.files.readUrl(tx, document.fileId),
        };
      }),
    );
  }

  /** A subject's live documents, oldest first, each with its read URL. */
  list(subject: DocumentSubject): Promise<DocumentRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const where = await this.subject(tx, subject, 'read');
      const documents = await tx.maintenanceDocument.findMany({
        where: { ...where, removedAt: null },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      });
      const out: DocumentRead[] = [];
      for (const document of documents)
        out.push({
          document,
          read: await this.files.readUrl(tx, document.fileId),
        });
      return out;
    });
  }

  add(
    subject: DocumentSubject,
    input: { fileId: string; kind: DocumentKind; title: string },
  ): Promise<DocumentRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: DOCUMENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const where = await this.subject(tx, subject, 'write');
      const live = await tx.maintenanceDocument.count({
        where: { ...where, removedAt: null },
      });
      if (live >= DOCUMENTS_PER_SUBJECT)
        throw appError.conflict(
          ErrorCode.MAINTENANCE_DOCUMENT_LIMIT_REACHED,
          'No more documents here',
          { params: { max: DOCUMENTS_PER_SUBJECT } },
        );
      const file = await this.files.claim(tx, input.fileId, 'asset_document');
      if (!file)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid document',
          {
            fields: [
              { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
            ],
          },
        );
      await this.files.attach(tx, file);
      const document = await tx.maintenanceDocument.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          ...where,
          fileId: file.id,
          kind: input.kind,
          title: input.title.trim(),
          addedById: this.ctx.accountId,
          addedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'maintenance_document.added',
        targetId: id,
        changes: { title: { changed: true } },
        metadata: { ...where, kind: input.kind, fileId: file.id },
      });
      return { document, read: await this.files.readUrl(tx, file.id) };
    });
  }

  /** Removed once: the row stays, its file goes (after commit). */
  remove(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM maintenance_documents WHERE id = ${id}::uuid FOR UPDATE`;
      const document = await tx.maintenanceDocument.findUnique({
        where: { id },
      });
      if (!document || document.removedAt !== null) throw documentNotFound();
      await tx.maintenanceDocument.update({
        where: { id },
        data: { removedAt: await dbNow(tx), removedById: this.ctx.accountId },
      });
      await this.files.markDeleted(
        tx,
        { id: document.fileId, purpose: 'asset_document' },
        'withdrawn',
      );
      await this.audit.record(tx, {
        action: 'maintenance_document.removed',
        targetId: id,
        metadata: { kind: document.kind },
      });
    });
  }

  /**
   * Exactly one subject, found (404 by its own code); for a write, locked
   * first, and an asset or an area must not be retired (409).
   */
  private async subject(
    tx: TenantTxClient,
    s: DocumentSubject,
    mode: 'read' | 'write',
  ): Promise<DocumentSubject> {
    const given = (
      ['assetId', 'assetTypeId', 'commonAreaId', 'contractId'] as const
    ).filter((k) => s[k] !== undefined);
    if (given.length !== 1) {
      const fields: FieldError[] = given.length
        ? given
            .slice(1)
            .map((field) => ({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED }))
        : [{ field: 'assetId', code: FieldErrorCode.FIELD_REQUIRED }];
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Name one subject',
        {
          fields,
        },
      );
    }
    // A write takes the subject's row first, exclusively among writers (NO
    // KEY UPDATE: what points at it may still be inserted), so the count
    // that follows is the one the insert passes; then it checks the row.
    if (mode === 'write') {
      if (s.assetId !== undefined)
        await tx.$queryRaw`SELECT id FROM assets WHERE id = ${s.assetId}::uuid FOR NO KEY UPDATE`;
      else if (s.commonAreaId !== undefined)
        await tx.$queryRaw`SELECT id FROM common_areas WHERE id = ${s.commonAreaId}::uuid FOR NO KEY UPDATE`;
      else if (s.contractId !== undefined)
        await tx.$queryRaw`SELECT id FROM maintenance_contracts WHERE id = ${s.contractId}::uuid FOR NO KEY UPDATE`;
      else
        await tx.$queryRaw`SELECT id FROM asset_types WHERE id = ${s.assetTypeId}::uuid FOR NO KEY UPDATE`;
    }
    if (s.assetId !== undefined) {
      const asset = await this.assets.find(tx, s.assetId);
      if (mode === 'write' && asset.status === 'retired')
        throw appError.conflict(
          ErrorCode.ASSET_RETIRED,
          'This asset is retired',
        );
      return { assetId: s.assetId };
    }
    if (s.commonAreaId !== undefined) {
      const area = await this.areas.find(tx, s.commonAreaId);
      if (mode === 'write' && !area.active)
        throw appError.conflict(
          ErrorCode.COMMON_AREA_RETIRED,
          'This common area is retired',
        );
      return { commonAreaId: s.commonAreaId };
    }
    if (s.contractId !== undefined) {
      const contract = await tx.maintenanceContract.findUnique({
        where: { id: s.contractId },
      });
      if (!contract) throw contractNotFound();
      return { contractId: s.contractId };
    }
    if (!(await tx.assetType.findUnique({ where: { id: s.assetTypeId } })))
      throw assetTypeNotFound();
    return { assetTypeId: s.assetTypeId };
  }
}
