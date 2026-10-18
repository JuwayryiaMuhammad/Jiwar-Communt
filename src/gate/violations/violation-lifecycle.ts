import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';

/**
 * What an erasure does to violations (ADR 0053), as to fines (ADR 0045),
 * in its transaction, which holds the account's row: the appeals it wrote
 * lose their words and photo, once each, audited by id. The violations
 * stay, the unit's record, with the appeal's decision; the issuer's note
 * and photo are the unit's, not the issuer's, and stay too. A deactivation
 * changes nothing: a violation is the unit's.
 *
 * Locks: violation rows by id, FOR UPDATE.
 */
@Injectable()
export class ViolationLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id);
      return [];
    });
  }

  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM unit_violations
       WHERE appealed_by_account_id = ${accountId}::uuid
         AND appeal_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      const before = await tx.unitViolation.findUniqueOrThrow({
        where: { id },
      });
      await tx.unitViolation.update({
        where: { id },
        data: {
          appealText: null,
          appealPhotoFileId: null,
          appealClearedAt: now,
        },
      });
      if (before.appealPhotoFileId)
        await this.files.markDeleted(
          tx,
          { id: before.appealPhotoFileId, purpose: 'violation_appeal_photo' },
          'erasure',
        );
      await this.audit.record(tx, {
        action: 'violation.appeal_cleared',
        targetId: id,
        metadata: {
          unitId: before.unitId,
          photo: before.appealPhotoFileId !== null,
        },
      });
    }
  }
}
