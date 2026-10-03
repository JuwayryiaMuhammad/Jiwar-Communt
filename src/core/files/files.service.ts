import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { FilePurpose, StoredFile } from '@prisma/client';
import { PermissionsService } from '../access/permissions.service';
import { AccountLifecycle } from '../accounts/account-lifecycle';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { SweepRunner } from '../sweep/sweep-runner';
import { AttachedFileUrls } from './attached-file-urls';
import {
  ObjectStorage,
  objectKey,
  type PresignedRead,
  type PresignedUpload,
} from './object-storage';
import { FILE_PURPOSES, type FileContentType } from './purposes';
import { matchesSignature, SIGNATURE_BYTES } from './signatures';

/**
 * A PUT is checked when it starts, so an upload begun just before its URL
 * expired may finish minutes later: finalize waits this long after expiry.
 */
export const FINALIZE_GRACE_MS = 15 * 60_000;
/** The sweep takes an unfinalized upload only after this, well past finalize. */
export const PENDING_SWEEP_AFTER_MS = 60 * 60_000;
/** Live (not yet expired) unfinalized uploads one account may hold. */
export const PENDING_LIMIT = 10;
/** Rows one sweep run takes per compound and step. */
const SWEEP_BATCH = 500;

export const FILES_SWEEP = 'files.cleanup';

/** Why a file was deleted (audit metadata.reasonCode). */
export type FileDeleteReason =
  | 'owner'
  | 'content_mismatch'
  | 'upload_expired'
  | 'erasure'
  /** An attached file another one replaced. */
  | 'replaced'
  /** Handed to an action that did not need it (the record had one). */
  | 'unused'
  /** Its record's retention ended (a worker's photo, ADR 0029). */
  | 'retention';

export { objectKey };

export interface NewUpload {
  file: StoredFile;
  upload: PresignedUpload;
}

export interface FileRead {
  file: StoredFile;
  read: PresignedRead | null;
}

const notFound = () =>
  appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');

const invalid = (
  field: string,
  code: FieldErrorCode,
  message: string,
  params: Record<string, string | number | string[]>,
) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, message, {
    fields: [{ field, code, params }],
  });

/**
 * Files in the private bucket (ADR 0029). The client declares a purpose,
 * a type and a size, uploads with the presigned PUT (the store refuses any
 * other size or type, and a second PUT), then finalizes: the server checks
 * the object's size, type and first bytes before the file is usable.
 *
 * Every endpoint here is the owner's own: another account's file, another
 * compound's, and a deleted one are all FILE_NOT_FOUND. Rows are locked
 * (FOR UPDATE) by finalize, delete and the sweep, and store calls happen
 * outside any transaction.
 */
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    private readonly storage: ObjectStorage,
    private readonly attachedUrls: AttachedFileUrls,
    private readonly sweep: SweepRunner,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.sweep.register(FILES_SWEEP, (now) => this.cleanUp(now));
    // An erased account's own files go with it (ADR 0023): marked in the
    // erasure's transaction, objects deleted after it commits (the sweep
    // finishes whatever fails).
    this.lifecycle.onErasing(async (tx, account) => {
      const owned = await tx.storedFile.findMany({
        where: { ownerAccountId: account.id, deletedAt: null },
        select: { id: true, purpose: true },
      });
      for (const file of owned) await this.markDeleted(tx, file, 'erasure');
      // The account's own photo (ADR 0031) is attached, not owned: the
      // account points at it, so the pointer goes in the same transaction.
      const photo = await tx.account.findUnique({
        where: { id: account.id },
        select: { photoFileId: true },
      });
      if (photo?.photoFileId) {
        await tx.account.update({
          where: { id: account.id },
          data: { photoFileId: null },
        });
        const file = {
          id: photo.photoFileId,
          purpose: 'resident_photo',
        } as const;
        await this.markDeleted(tx, file, 'erasure');
        owned.push(file);
      }
      return owned.map((file) => async () => {
        await this.purge(file.id);
      });
    });
  }

  async createUpload(input: {
    purpose: FilePurpose;
    contentType: string;
    size: number;
  }): Promise<NewUpload> {
    const purpose = FILE_PURPOSES[input.purpose];
    if (!(await this.mayUpload(input.purpose))) {
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'This account cannot upload files for this purpose',
      );
    }
    const types: readonly string[] = purpose.types;
    if (!types.includes(input.contentType)) {
      throw invalid(
        'contentType',
        FieldErrorCode.FILE_TYPE_NOT_ALLOWED,
        'This purpose does not take this type',
        { allowed: [...purpose.types] },
      );
    }
    if (input.size > purpose.maxBytes) {
      throw invalid(
        'size',
        FieldErrorCode.FILE_TOO_LARGE,
        'The file is larger than this purpose allows',
        { maxBytes: purpose.maxBytes },
      );
    }

    const id = newId();
    const tenantId = this.ctx.tenantId;
    const owner = this.ctx.accountId;
    // Signed first: a store that is down fails before any row exists.
    const upload = await this.storage.presignPut(
      objectKey({ tenantId, id }),
      input.contentType,
      input.size,
    );
    const file = await this.tenantTx.withTenantTx(async (tx) => {
      // The owner's row lock makes the count and the insert one step, so
      // parallel requests cannot pass the limit together.
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${owner}::uuid FOR UPDATE`;
      const live = await tx.storedFile.count({
        where: {
          ownerAccountId: owner,
          status: 'pending',
          deletedAt: null,
          uploadExpiresAt: { gt: new Date(Date.now() - FINALIZE_GRACE_MS) },
        },
      });
      if (live >= PENDING_LIMIT) {
        throw appError.tooManyRequests(
          ErrorCode.FILE_PENDING_LIMIT,
          'Too many uploads waiting to be finalized',
          { params: { limit: PENDING_LIMIT } },
        );
      }
      const created = await tx.storedFile.create({
        data: {
          id,
          tenantId,
          ownerAccountId: owner,
          purpose: input.purpose,
          contentType: input.contentType,
          sizeBytes: input.size,
          uploadExpiresAt: upload.expiresAt,
        },
      });
      await this.audit.record(tx, {
        action: 'file.created',
        targetId: id,
        metadata: {
          purpose: input.purpose,
          contentType: input.contentType,
          size: input.size,
        },
      });
      return created;
    });
    return { file, upload };
  }

  /**
   * Makes an uploaded file usable once its object is exactly what was
   * declared. A finalized file finalizes again as a no-op. An object that
   * is not what was declared is deleted with its row (FILE_CONTENT_MISMATCH).
   */
  async finalize(id: string): Promise<StoredFile> {
    const file = await this.tenantTx.withTenantTx((tx) => this.own(tx, id));
    if (file.status === 'ready') return file;
    this.refuseExpired(file);

    const key = objectKey(file);
    const head = await this.storage.head(key);
    if (!head) {
      throw appError.conflict(
        ErrorCode.FILE_UPLOAD_MISSING,
        'Nothing has been uploaded for this file yet',
      );
    }
    const matches =
      head.size === file.sizeBytes &&
      head.contentType === file.contentType &&
      matchesSignature(
        file.contentType as FileContentType,
        await this.storage.firstBytes(key, SIGNATURE_BYTES),
      );
    if (!matches) {
      await this.removeOwn(id, 'content_mismatch');
      throw appError.unprocessable(
        ErrorCode.FILE_CONTENT_MISMATCH,
        'The uploaded bytes are not the declared file',
      );
    }

    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, id);
      const current = await this.own(tx, id);
      if (current.status === 'ready') return current;
      this.refuseExpired(current);
      return tx.storedFile.update({
        where: { id },
        data: { status: 'ready', finalizedAt: new Date() },
      });
    });
  }

  /** The file, and a read URL once it is finalized. */
  async read(id: string): Promise<FileRead> {
    const file = await this.tenantTx.withTenantTx((tx) => this.own(tx, id));
    return {
      file,
      read:
        file.status === 'ready'
          ? await this.storage.presignGet(objectKey(file))
          : null,
    };
  }

  async remove(id: string): Promise<void> {
    await this.removeOwn(id, 'owner');
  }

  /**
   * Takes one of the caller's own finalized files of this purpose for a
   * record, in the record's transaction: the row is locked, and null means
   * it is not such a file (anyone else's, pending, deleted, attached, of
   * another purpose or unknown — one answer). `attach` or `markDeleted`
   * must follow in the same transaction.
   */
  async claim(
    tx: TenantTxClient,
    id: string,
    purpose: FilePurpose,
  ): Promise<StoredFile | null> {
    await this.lock(tx, id);
    return tx.storedFile.findFirst({
      where: {
        id,
        purpose,
        status: 'ready',
        deletedAt: null,
        ownerAccountId: this.ctx.accountId,
      },
    });
  }

  /**
   * The claimed file leaves its uploader for the record: no owner, so the
   * uploader can no longer read or delete it and their erasure leaves it.
   * The record's own views read it through `readUrl`.
   */
  async attach(tx: TenantTxClient, file: StoredFile): Promise<void> {
    await tx.storedFile.update({
      where: { id: file.id },
      data: { ownerAccountId: null, attachedAt: new Date() },
    });
  }

  /**
   * A read URL for a record's attached file (presigning is local: no store
   * call). The caller has authorized the reader; null when it is gone.
   */
  readUrl(
    tx: TenantTxClient,
    id: string | null,
  ): Promise<PresignedRead | null> {
    return this.attachedUrls.read(tx, id);
  }

  /**
   * Marks a file deleted in the caller's transaction (audited); the object
   * and then the row go after commit through `purge`, or with the sweep.
   * Returns false when there was nothing left to delete.
   */
  async markDeleted(
    tx: TenantTxClient,
    file: Pick<StoredFile, 'id' | 'purpose'>,
    reasonCode: FileDeleteReason,
  ): Promise<boolean> {
    const { count } = await tx.storedFile.updateMany({
      where: { id: file.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!count) return false;
    await this.audit.record(tx, {
      action: 'file.deleted',
      targetId: file.id,
      metadata: { purpose: file.purpose, reasonCode },
    });
    return true;
  }

  /**
   * Deletes the object of a file marked deleted, then its row. A failed
   * object delete keeps the row, so the sweep tries again: an object never
   * outlives the row that names it. Runs in the request's tenant.
   */
  async purge(id: string): Promise<boolean> {
    if (
      !(await this.storage.delete(
        objectKey({ tenantId: this.ctx.tenantId, id }),
      ))
    )
      return false;
    await this.tenantTx.withTenantTx((tx) =>
      tx.storedFile.deleteMany({ where: { id, deletedAt: { not: null } } }),
    );
    return true;
  }

  /**
   * The sweep (ADR 0029): uploads never finalized are marked deleted once
   * well past finalize's grace; then every deleted file loses its object
   * and, only after that succeeded, its row. Store calls run between the
   * two tenant transactions, never inside one.
   */
  async cleanUp(now: Date): Promise<number> {
    const before = new Date(now.getTime() - PENDING_SWEEP_AFTER_MS);
    const due = new Map<string, string[]>();
    let done = await this.sweep.forEachTenant(async (tx, tenantId) => {
      // SKIP LOCKED: a row a finalize holds is left for the next run, and
      // finalize sees the deletion if the sweep got there first.
      const expired = await tx.$queryRaw<
        { id: string; purpose: FilePurpose }[]
      >`
        SELECT id, purpose FROM files
         WHERE status = 'pending' AND deleted_at IS NULL
           AND upload_expires_at < ${before}
         ORDER BY upload_expires_at LIMIT ${SWEEP_BATCH}
         FOR UPDATE SKIP LOCKED`;
      for (const file of expired)
        await this.markDeleted(tx, file, 'upload_expired');
      const deleted = await tx.storedFile.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true },
        orderBy: { deletedAt: 'asc' },
        take: SWEEP_BATCH,
      });
      if (deleted.length)
        due.set(
          tenantId,
          deleted.map((f) => f.id),
        );
      return expired.length;
    });

    const gone = new Map<string, string[]>();
    for (const [tenantId, ids] of due) {
      const ok: string[] = [];
      for (const id of ids) {
        if (await this.storage.delete(objectKey({ tenantId, id }))) ok.push(id);
      }
      if (ok.length) gone.set(tenantId, ok);
    }
    if (gone.size) {
      done += await this.sweep.forEachTenant(async (tx, tenantId) => {
        const ids = gone.get(tenantId);
        if (!ids) return 0;
        const { count } = await tx.storedFile.deleteMany({
          where: { id: { in: ids }, deletedAt: { not: null } },
        });
        return count;
      });
    }
    return done;
  }

  private async removeOwn(id: string, reason: FileDeleteReason): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, id);
      const file = await this.own(tx, id);
      await this.markDeleted(tx, file, reason);
    });
    try {
      await this.purge(id);
    } catch (error) {
      // Committed already; the sweep finishes it.
      this.logger.warn(
        `file purge deferred to the sweep (${error instanceof Error ? error.name : 'Error'})`,
      );
    }
  }

  private async mayUpload(purpose: FilePurpose): Promise<boolean> {
    for (const p of FILE_PURPOSES[purpose].uploaders) {
      if (await this.permissions.has(p)) return true;
    }
    return false;
  }

  /** The caller's own live file, or FILE_NOT_FOUND. */
  private async own(tx: TenantTxClient, id: string): Promise<StoredFile> {
    const file = await tx.storedFile.findFirst({
      where: { id, ownerAccountId: this.ctx.accountId, deletedAt: null },
    });
    if (!file) throw notFound();
    return file;
  }

  private async lock(tx: TenantTxClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM files WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private refuseExpired(file: StoredFile): void {
    if (Date.now() > file.uploadExpiresAt.getTime() + FINALIZE_GRACE_MS) {
      throw appError.conflict(
        ErrorCode.FILE_UPLOAD_EXPIRED,
        'The upload expired; start a new one',
      );
    }
  }
}
