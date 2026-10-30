import { Injectable } from '@nestjs/common';
import type { CompoundDocumentVersion } from '@prisma/client';
import { CommunityGovernancePort } from '../../community';
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
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { Notifier } from '../../core/notifications/notifier';
import { dbNow } from '../db-clock';

export const COMPOUND_DOCUMENT_KINDS = [
  'bylaws',
  'occupant_rights',
  'conduct_guide',
  'moving_guide',
  // How to use less water, power and gas at home (ADR 0069): a guide.
  'saving_tips',
] as const;
export type CompoundDocumentKind = (typeof COMPOUND_DOCUMENT_KINDS)[number];
/** Publishing these tells everyone in the compound; the guides do not. */
const ANNOUNCED: readonly CompoundDocumentKind[] = [
  'bylaws',
  'occupant_rights',
];

export interface CompoundDocumentSummary {
  id: string;
  kind: CompoundDocumentKind;
  versionNo: number;
  titleEn: string;
  titleAr: string;
  effectiveOn: Date;
  publishedAt: Date;
  hasFile: boolean;
}

export interface CompoundDocumentRead extends CompoundDocumentSummary {
  bodyEn: string;
  bodyAr: string;
  changesEn: string | null;
  changesAr: string | null;
  boardPublicationId: string | null;
}

export interface NewVersion {
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  changesEn?: string;
  changesAr?: string;
  /** `YYYY-MM-DD`. */
  effectiveOn: string;
  fileId?: string;
  boardPublicationId?: string;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.COMPOUND_DOCUMENT_NOT_FOUND,
    'Compound document not found',
  );

/**
 * The compound's documents (ADR 0062): the bylaws, the occupants' rights
 * in plain language, the code of conduct and the moving guide. The
 * management (`content.manage`) publishes versions; an amendment is a new
 * version saying what it changes. A bylaws version cites the board's
 * published decision that adopted it (ADR 0051): the board decides, the
 * management publishes. Everyone with a place in the compound reads them;
 * the bylaws and the rights are announced to everyone when a version is
 * published. Versions are numbered per kind under an advisory lock and
 * never change (trigger).
 */
@Injectable()
export class CompoundDocumentsService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly community: CommunityGovernancePort,
  ) {}

  /** The latest version of each kind published so far. */
  current(): Promise<CompoundDocumentSummary[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.compoundDocumentVersion.findMany({
        distinct: ['kind'],
        orderBy: [{ kind: 'asc' }, { versionNo: 'desc' }],
      });
      return rows.map(summary);
    });
  }

  /** A kind's versions, newest first, without their bodies. */
  versions(kind: string): Promise<CompoundDocumentSummary[]> {
    const k = kindOf(kind);
    return this.tenantTx.withTenantTx(async (tx) =>
      (
        await tx.compoundDocumentVersion.findMany({
          where: { kind: k },
          orderBy: { versionNo: 'desc' },
        })
      ).map(summary),
    );
  }

  /** One version in full, with its PDF's read URL when it has one (no-store). */
  version(
    id: string,
  ): Promise<{ document: CompoundDocumentRead; read: PresignedRead | null }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.compoundDocumentVersion.findUnique({
        where: { id },
      });
      if (!row) throw notFound();
      return {
        document: full(row),
        read: row.fileId ? await this.files.readUrl(tx, row.fileId) : null,
      };
    });
  }

  /** Publishes the kind's next version. */
  async publish(
    input: NewVersion & { kind: string },
  ): Promise<CompoundDocumentRead> {
    const k = kindOf(input.kind);
    const valid = validate(k, input);
    return this.tenantTx.withTenantTx(async (tx) => {
      // One numbering per compound and kind.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        hashtext(${`compound-document:${this.ctx.txTenantId}`}), hashtext(${k}))`;
      const last = await tx.compoundDocumentVersion.findFirst({
        where: { kind: k },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      });
      const versionNo = (last?.versionNo ?? 0) + 1;
      if (versionNo === 1 && (valid.changesEn || valid.changesAr))
        throw invalid([
          { field: 'changesEn', code: FieldErrorCode.FIELD_NOT_ALLOWED },
        ]);
      if (versionNo > 1 && (!valid.changesEn || !valid.changesAr))
        throw invalid([
          {
            field: valid.changesEn ? 'changesAr' : 'changesEn',
            code: FieldErrorCode.FIELD_REQUIRED,
          },
        ]);
      if (k === 'bylaws')
        await this.requireDecision(tx, valid.boardPublicationId!);
      let fileId: string | null = null;
      if (valid.fileId) {
        const file = await this.files.claim(
          tx,
          valid.fileId,
          'compound_document',
        );
        if (!file)
          throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
        await this.files.attach(tx, file);
        fileId = file.id;
      }
      const row = await tx.compoundDocumentVersion.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          kind: k,
          versionNo,
          titleEn: valid.titleEn,
          titleAr: valid.titleAr,
          bodyEn: valid.bodyEn,
          bodyAr: valid.bodyAr,
          changesEn: versionNo > 1 ? valid.changesEn : null,
          changesAr: versionNo > 1 ? valid.changesAr : null,
          effectiveOn: valid.effectiveOn,
          fileId,
          boardPublicationId: k === 'bylaws' ? valid.boardPublicationId : null,
          publishedBy: this.ctx.accountId,
          publishedAt: await dbNow(tx),
        },
      });
      const told = ANNOUNCED.includes(k)
        ? await this.notifier.notify(tx, await this.community.everyone(tx), {
            kind: 'compound_document.published',
            params: { subject: k, versionNo: String(versionNo) },
            targetId: row.id,
          })
        : 0;
      await this.audit.record(tx, {
        action: 'compound_document.published',
        targetId: row.id,
        metadata: {
          kind: k,
          versionNo,
          hasFile: fileId !== null,
          ...(row.boardPublicationId
            ? { boardPublicationId: row.boardPublicationId }
            : {}),
          told,
        },
      });
      return full(row);
    });
  }

  /** The bylaws cite a decision the board published, not archived. */
  private async requireDecision(tx: TenantTxClient, id: string): Promise<void> {
    const publication = await tx.boardPublication.findFirst({
      where: { id, kind: 'decision', archivedAt: null },
      select: { id: true },
    });
    if (!publication)
      throw appError.notFound(
        ErrorCode.BOARD_PUBLICATION_NOT_FOUND,
        'No published board decision has this id',
      );
  }
}

function kindOf(kind: string): CompoundDocumentKind {
  if (!(COMPOUND_DOCUMENT_KINDS as readonly string[]).includes(kind))
    throw notFound();
  return kind as CompoundDocumentKind;
}

function summary(r: CompoundDocumentVersion): CompoundDocumentSummary {
  return {
    id: r.id,
    kind: r.kind as CompoundDocumentKind,
    versionNo: r.versionNo,
    titleEn: r.titleEn,
    titleAr: r.titleAr,
    effectiveOn: r.effectiveOn,
    publishedAt: r.publishedAt,
    hasFile: r.fileId !== null,
  };
}

function full(r: CompoundDocumentVersion): CompoundDocumentRead {
  return {
    ...summary(r),
    bodyEn: r.bodyEn,
    bodyAr: r.bodyAr,
    changesEn: r.changesEn,
    changesAr: r.changesAr,
    boardPublicationId: r.boardPublicationId,
  };
}

function invalid(fields: FieldError[]) {
  return appError.badRequest(
    ErrorCode.VALIDATION_FAILED,
    'Invalid document version',
    { fields },
  );
}

interface ValidVersion extends Omit<NewVersion, 'effectiveOn'> {
  effectiveOn: Date;
}

function validate(kind: CompoundDocumentKind, input: NewVersion): ValidVersion {
  const fields: FieldError[] = [];
  if (kind === 'bylaws' && !input.boardPublicationId)
    fields.push({
      field: 'boardPublicationId',
      code: FieldErrorCode.FIELD_REQUIRED,
    });
  if (kind !== 'bylaws' && input.boardPublicationId)
    fields.push({
      field: 'boardPublicationId',
      code: FieldErrorCode.FIELD_NOT_ALLOWED,
    });
  if (fields.length) throw invalid(fields);
  return {
    ...input,
    titleEn: input.titleEn.trim(),
    titleAr: input.titleAr.trim(),
    effectiveOn: new Date(`${input.effectiveOn}T00:00:00Z`),
  };
}
