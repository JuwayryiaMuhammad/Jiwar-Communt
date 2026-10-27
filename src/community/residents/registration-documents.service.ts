import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  OccupancyType,
  RegistrationStatus,
  ResidentRegistration,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../core/audit/audit.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Env } from '../../core/config/env.schema';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { FileContentType } from '../../core/files/purposes';
import type { PresignedUpload } from '../../core/files/object-storage';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { dbNow } from '../db-clock';
import {
  isRegistrationStatusToken,
  RegistrationStatusLinks,
} from './registration-status-links';

/** Live documents per request, uploads not yet finalized included. */
export const REGISTRATION_DOCUMENT_LIMIT = 3;

export const REGISTRATION_DOCUMENT_KINDS = [
  'ownership_proof',
  'lease_proof',
  'other_proof',
] as const;
export type RegistrationDocumentKind =
  (typeof REGISTRATION_DOCUMENT_KINDS)[number];

/** The undecided statuses: the only ones a link opens. */
export const OPEN_REGISTRATION: RegistrationStatus[] = [
  'pending',
  'needs_correction',
];

export interface RegistrationDocumentRead {
  id: string;
  kind: RegistrationDocumentKind;
  contentType: FileContentType;
  /** Finalized: the upload arrived and was checked. */
  ready: boolean;
  createdAt: Date;
}

/** What a registrant sees: the state of their request, never its personal data. */
export interface RegistrationStatusRead {
  compoundName: string;
  status: 'pending' | 'needs_correction';
  unitCode: string;
  occupancyType: OccupancyType;
  correctionCodes: string[];
  documents: RegistrationDocumentRead[];
  maxDocuments: number;
  createdAt: Date;
}

interface Resolved {
  tenantId: string;
  registrationId: string;
  seq: number;
  compoundName: string;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.REGISTRATION_STATUS_NOT_FOUND,
    'Registration request not found',
  );

/**
 * The registrant's side of a request (ADR 0062), opened by the status link
 * emailed to them: no account, the link is the credential until the
 * decision. The token arrives in a POST body and resolves through the
 * global pointer; every token that does not open an undecided request —
 * malformed, unknown, replaced by a newer link, decided, expired, a
 * suspended compound's — is the same 404, rate-limited per IP and per link
 * before anything is read.
 *
 * Every change takes the request's row lock first and checks it is still
 * undecided under it: the decision takes the same lock and deletes the
 * pointer, so nothing is added to a decided request.
 *
 * This file may use runInTenantUnsafe (eslint.config.mjs): the compound
 * comes from the link before anyone is logged in.
 */
@Injectable()
export class RegistrationDocumentsService {
  /** Status-link calls a minute, per IP and per link. */
  private readonly perIp: number;
  private readonly perToken: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly cls: ClsService<AppClsStore>,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly links: RegistrationStatusLinks,
  ) {
    this.perIp = config.get('REGISTRATION_STATUS_RATE_LIMIT_PER_IP', {
      infer: true,
    });
    this.perToken = config.get('REGISTRATION_STATUS_RATE_LIMIT_PER_TOKEN', {
      infer: true,
    });
  }

  async lookup(token: string, ip: string): Promise<RegistrationStatusRead> {
    const link = await this.resolve(token, ip);
    return this.asRegistrant(link, async (tx) => {
      const reg = await this.open(tx, link, false);
      return this.read(tx, link, reg);
    });
  }

  /**
   * Starts an upload of a document: a presigned PUT, the file attached to
   * the request from the start. Finalize it once the bytes are up.
   */
  async startUpload(
    token: string,
    ip: string,
    input: {
      kind: RegistrationDocumentKind;
      contentType: string;
      size: number;
    },
  ): Promise<{ document: RegistrationDocumentRead; upload: PresignedUpload }> {
    const link = await this.resolve(token, ip);
    return this.inCompound(link, async () => {
      // Signed first, outside the transaction; refused types and sizes
      // stop here, before anything is written.
      const declared = {
        purpose: 'registration_document' as const,
        contentType: input.contentType,
        size: input.size,
      };
      const { id: fileId, upload } =
        await this.files.presignForRecord(declared);
      return this.tenantTx.runInTenantUnsafe(link.tenantId, async (tx) => {
        const reg = await this.open(tx, link, true);
        const live = await this.liveCount(tx, reg.id);
        if (live >= REGISTRATION_DOCUMENT_LIMIT)
          throw appError.conflict(
            ErrorCode.REGISTRATION_DOCUMENT_LIMIT,
            'A request holds three documents at most',
            { params: { limit: REGISTRATION_DOCUMENT_LIMIT } },
          );
        const at = await dbNow(tx);
        const file = await this.files.createForRecord(tx, {
          ...declared,
          id: fileId,
          upload,
          at,
        });
        const id = newId();
        await tx.registrationDocument.create({
          data: {
            id,
            tenantId: link.tenantId,
            registrationId: reg.id,
            fileId: file.id,
            kind: input.kind,
            createdAt: at,
          },
        });
        await this.audit.record(tx, {
          action: 'resident.registration_document_added',
          targetId: reg.id,
          metadata: { documentId: id, kind: input.kind },
        });
        return {
          document: {
            id,
            kind: input.kind,
            contentType: file.contentType as FileContentType,
            ready: false,
            createdAt: at,
          },
          upload,
        };
      });
    });
  }

  /** Checks the uploaded bytes (size, type, first bytes); a mismatch deletes them. */
  async finalize(
    token: string,
    ip: string,
    documentId: string,
  ): Promise<RegistrationDocumentRead> {
    const link = await this.resolve(token, ip);
    return this.inCompound(link, async () => {
      const doc = await this.tenantTx.runInTenantUnsafe(link.tenantId, (tx) =>
        this.document(tx, link, documentId),
      );
      // The file's row lock, then the request: still undecided, still its.
      const file = await this.files.finalizeForRecord(
        doc.fileId,
        async (tx) => {
          const reg = await tx.residentRegistration.findFirst({
            where: {
              id: link.registrationId,
              status: { in: OPEN_REGISTRATION },
              statusLinkSeq: link.seq,
            },
            select: { id: true },
          });
          if (!reg) return false;
          return (
            (await tx.registrationDocument.count({
              where: { id: doc.id, registrationId: reg.id },
            })) === 1
          );
        },
      );
      return {
        id: doc.id,
        kind: doc.kind as RegistrationDocumentKind,
        contentType: file.contentType as FileContentType,
        ready: file.status === 'ready',
        createdAt: doc.createdAt,
      };
    });
  }

  /** A wrong document goes (its file is deleted); another may then be uploaded. */
  async remove(token: string, ip: string, documentId: string): Promise<void> {
    const link = await this.resolve(token, ip);
    await this.inCompound(link, async () => {
      const fileId = await this.tenantTx.runInTenantUnsafe(
        link.tenantId,
        async (tx) => {
          const reg = await this.open(tx, link, true);
          const doc = await this.document(tx, link, documentId);
          await this.files.markDeleted(
            tx,
            { id: doc.fileId, purpose: 'registration_document' },
            'owner',
          );
          await this.audit.record(tx, {
            action: 'resident.registration_document_removed',
            targetId: reg.id,
            metadata: { documentId: doc.id, kind: doc.kind },
          });
          return doc.fileId;
        },
      );
      // Committed; the sweep finishes a purge that fails.
      await this.files.purge(fileId).catch(() => false);
    });
  }

  /**
   * Sends a request back to the management after a correction: it waits
   * for review again. One finalized document at least.
   */
  async resubmit(token: string, ip: string): Promise<RegistrationStatusRead> {
    const link = await this.resolve(token, ip);
    return this.asRegistrant(link, async (tx) => {
      const reg = await this.open(tx, link, true);
      if (reg.status !== 'needs_correction')
        throw appError.conflict(
          ErrorCode.REGISTRATION_NOT_AWAITING_CORRECTION,
          'The management did not ask for a correction',
        );
      const ready = await tx.registrationDocument.count({
        where: {
          registrationId: reg.id,
          file: { status: 'ready', deletedAt: null },
        },
      });
      if (ready === 0)
        throw appError.conflict(
          ErrorCode.REGISTRATION_DOCUMENTS_REQUIRED,
          'Upload one document at least first',
        );
      const now = await dbNow(tx);
      const after = await tx.residentRegistration.update({
        where: { id: reg.id },
        data: {
          status: 'pending',
          correctionCodes: [],
          resubmittedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'resident.registration_resubmitted',
        targetId: reg.id,
        metadata: { documentCount: ready },
      });
      return this.read(tx, link, after);
    });
  }

  // --------------------------------------------------------------------------

  /** Rate limits, then the pointer; every miss is the same 404. */
  private async resolve(token: string, ip: string): Promise<Resolved> {
    const tokenHash = this.links.pointerOf(String(token ?? ''));
    await this.rateLimit.consume(
      `registration-status:ip:${ip}`,
      this.perIp,
      60,
    );
    await this.rateLimit.consume(
      `registration-status:token:${tokenHash}`,
      this.perToken,
      60,
    );
    if (!isRegistrationStatusToken(token)) throw notFound();
    const link = await this.globalDb.registrationStatusLink.findUnique({
      where: { tokenHash },
      include: { tenant: { select: { status: true, name: true } } },
    });
    if (!link || link.tenant.status !== 'active') throw notFound();
    return {
      tenantId: link.tenantId,
      registrationId: link.registrationId,
      seq: link.seq,
      compoundName: link.tenant.name,
    };
  }

  /**
   * In the link's compound, as the system (the registrant is no account),
   * with the compound set for the files service's own transactions.
   */
  private inCompound<T>(link: Resolved, fn: () => Promise<T>): Promise<T> {
    return this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set('tenantId', link.tenantId);
      this.cls.set('auditActor', { type: 'system', id: null });
      return fn();
    });
  }

  private asRegistrant<T>(
    link: Resolved,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    return this.inCompound(link, () =>
      this.tenantTx.runInTenantUnsafe(link.tenantId, fn),
    );
  }

  /**
   * The link's request while undecided and the link is its newest (the
   * pointer was read before any lock; the row says so under it).
   */
  private async open(
    tx: TenantTxClient,
    link: Resolved,
    lock: boolean,
  ): Promise<ResidentRegistration> {
    if (lock)
      await tx.$queryRaw`SELECT id FROM resident_registrations
         WHERE id = ${link.registrationId}::uuid FOR UPDATE`;
    const reg = await tx.residentRegistration.findUnique({
      where: { id: link.registrationId },
    });
    if (
      !reg ||
      !OPEN_REGISTRATION.includes(reg.status) ||
      reg.statusLinkSeq !== link.seq
    )
      throw notFound();
    return reg;
  }

  /** One of the request's live documents, or not found. */
  private async document(
    tx: TenantTxClient,
    link: Resolved,
    documentId: string,
  ) {
    const doc = await tx.registrationDocument.findFirst({
      where: {
        id: documentId,
        registrationId: link.registrationId,
        file: { deletedAt: null },
      },
    });
    if (!doc)
      throw appError.notFound(
        ErrorCode.REGISTRATION_DOCUMENT_NOT_FOUND,
        'Document not found',
      );
    return doc;
  }

  /** Live documents: uploads not yet finalized count until they are swept. */
  private liveCount(tx: TenantTxClient, registrationId: string) {
    return tx.registrationDocument.count({
      where: { registrationId, file: { deletedAt: null } },
    });
  }

  private async read(
    tx: TenantTxClient,
    link: Resolved,
    reg: ResidentRegistration,
  ): Promise<RegistrationStatusRead> {
    return {
      compoundName: link.compoundName,
      status: reg.status as 'pending' | 'needs_correction',
      unitCode: reg.unitCode,
      occupancyType: reg.occupancyType,
      correctionCodes: reg.correctionCodes,
      documents: await registrationDocuments(tx, reg.id),
      maxDocuments: REGISTRATION_DOCUMENT_LIMIT,
      createdAt: reg.createdAt,
    };
  }
}

/** A request's live documents, oldest first (the registrant's and the manager's views). */
export async function registrationDocuments(
  tx: TenantTxClient,
  registrationId: string,
): Promise<RegistrationDocumentRead[]> {
  const rows = await tx.registrationDocument.findMany({
    where: { registrationId, file: { deletedAt: null } },
    include: { file: { select: { contentType: true, status: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((d) => ({
    id: d.id,
    kind: d.kind as RegistrationDocumentKind,
    contentType: d.file.contentType as FileContentType,
    ready: d.file.status === 'ready',
    createdAt: d.createdAt,
  }));
}
