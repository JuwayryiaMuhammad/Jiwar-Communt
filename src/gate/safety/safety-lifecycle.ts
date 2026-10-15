import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';

/**
 * What happens to an account's gate service requests and emergencies when
 * it goes (ADR 0047), in the transaction of what made it go, which holds
 * the account's row:
 *
 * - **Deactivated** (an erasure deactivates first): its requests that are
 *   not over are cancelled by the system (`requester_left`): nobody is
 *   left to meet.
 * - **Erased**: what it wrote goes — a report's words and photo, a lane's
 *   notes — once, together (`text_cleared_at`). The requests stay, pointing
 *   at the tombstone, with security's notes. Emergencies hold no words of
 *   the household's: they stay as they are.
 *
 * Locks: request rows by id, FOR UPDATE; never a unit's lock or row.
 */
@Injectable()
export class SafetyLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.requesterLeft(tx, account.id);
      return [];
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.requesterLeft(tx, account.id);
      await this.forget(tx, account.id);
      return [];
    });
  }

  private async requesterLeft(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text AS status FROM gate_service_requests
       WHERE requested_by_account_id = ${accountId}::uuid
         AND status IN ('open', 'accepted', 'in_progress')
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id, status } of rows) {
      await tx.gateServiceRequest.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          cancelSide: 'system',
          cancelReason: 'requester_left',
        },
      });
      await this.audit.record(tx, {
        action: 'gate_service.cancelled',
        targetId: id,
        metadata: {
          from: status,
          side: 'system',
          reasonCode: 'requester_left',
        },
      });
    }
  }

  /** What the erased account wrote, and its photos. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM gate_service_requests
       WHERE requested_by_account_id = ${accountId}::uuid
         AND text_cleared_at IS NULL
         AND (description IS NOT NULL OR notes IS NOT NULL OR photo_file_id IS NOT NULL)
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      const before = await tx.gateServiceRequest.findUniqueOrThrow({
        where: { id },
      });
      await tx.gateServiceRequest.update({
        where: { id },
        data: {
          description: null,
          notes: null,
          photoFileId: null,
          textClearedAt: now,
        },
      });
      if (before.photoFileId)
        await this.files.markDeleted(
          tx,
          { id: before.photoFileId, purpose: 'gate_service_photo' },
          'erasure',
        );
      await this.audit.record(tx, {
        action: 'gate_service.text_cleared',
        targetId: id,
        metadata: {
          description: before.description !== null,
          notes: before.notes !== null,
          photo: before.photoFileId !== null,
        },
      });
    }
  }
}
