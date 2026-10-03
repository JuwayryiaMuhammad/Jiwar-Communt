import { Injectable, Logger } from '@nestjs/common';
import {
  runAfterCommit,
  type AfterCommit,
} from '../accounts/account-lifecycle';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { FilesService } from './files.service';

/**
 * An account's own photo (ADR 0031): a finalized `resident_photo` the
 * caller uploaded moves to the account, and the account points at it. The
 * guard sees it on a valid resident scan and the person on `GET /me`;
 * nobody else. Replacing or removing it marks the old file deleted in the
 * same transaction (its object goes after commit, or with the files sweep).
 * The account row is locked first, so two requests of one account queue.
 */
@Injectable()
export class AccountPhotoService {
  private readonly logger = new Logger(AccountPhotoService.name);

  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  async set(fileId: string): Promise<void> {
    const accountId = this.ctx.accountId;
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      const current = await this.lock(tx, accountId);
      const file = await this.files.claim(tx, fileId, 'resident_photo');
      // One answer for someone else's file, a pending one, a deleted one,
      // one already attached, another purpose and an unknown id.
      if (!file) throw notAvailable();
      await this.files.attach(tx, file);
      await tx.account.update({
        where: { id: accountId },
        data: { photoFileId: file.id },
      });
      if (current) {
        await this.files.markDeleted(
          tx,
          { id: current, purpose: 'resident_photo' },
          'replaced',
        );
        after.push(() => this.files.purge(current).then(() => undefined));
      }
      await this.record(tx, accountId, current, file.id);
    });
    await runAfterCommit(after, this.logger);
  }

  /** Nothing to remove is not an error: a retried delete is safe. */
  async remove(): Promise<void> {
    const accountId = this.ctx.accountId;
    const after: AfterCommit[] = [];
    await this.tenantTx.withTenantTx(async (tx) => {
      const current = await this.lock(tx, accountId);
      if (!current) return;
      await tx.account.update({
        where: { id: accountId },
        data: { photoFileId: null },
      });
      await this.files.markDeleted(
        tx,
        { id: current, purpose: 'resident_photo' },
        'owner',
      );
      after.push(() => this.files.purge(current).then(() => undefined));
      await this.record(tx, accountId, current, null);
    });
    await runAfterCommit(after, this.logger);
  }

  /** Locks the account row; returns its current photo file, if any. */
  private async lock(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<string | null> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
    const row = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { photoFileId: true },
    });
    return row.photoFileId;
  }

  private record(
    tx: TenantTxClient,
    accountId: string,
    from: string | null,
    to: string | null,
  ) {
    return this.audit.record(tx, {
      action: 'account.photo_changed',
      targetId: accountId,
      changes: diffChanges(
        { photo: from },
        { photo: to },
        'account.photo_changed',
      ),
    });
  }
}

function notAvailable() {
  return appError.badRequest(
    ErrorCode.VALIDATION_FAILED,
    'Not one of your finalized resident photos',
    { fields: [{ field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE }] },
  );
}
