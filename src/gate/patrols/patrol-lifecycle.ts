import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';

/**
 * What a guard's erasure does to their patrols (ADR 0052), in the
 * erasure's transaction, which holds their account's row. Their open shift
 * was ended first (ShiftsService), and with it their run under way.
 *
 * - **Their notes' words go**, once each, audited by id. The notes' outcomes
 *   and photos stay: the photos show a place, not the guard.
 * - **Where they walked goes**: their track points are deleted (their
 *   location is theirs), how many audited.
 * - Their runs and scans stay: the compound's record of its patrols. Views
 *   show an erased guard as `{ id, erased: true }`.
 */
@Injectable()
export class PatrolLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id);
      return [];
    });
  }

  private async forget(tx: TenantTxClient, guardId: string): Promise<void> {
    const now = await dbNow(tx);
    const notes = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM patrol_notes
       WHERE guard_account_id = ${guardId}::uuid AND text IS NOT NULL
       ORDER BY id FOR UPDATE`;
    for (const { id } of notes) {
      await tx.patrolNote.update({
        where: { id },
        data: { text: null, textClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'patrol_note.text_cleared',
        targetId: id,
      });
    }
    const { count } = await tx.patrolTrackPoint.deleteMany({
      where: { guardAccountId: guardId },
    });
    if (count)
      await this.audit.record(tx, {
        action: 'patrol_track.erased',
        targetId: guardId,
        metadata: { points: count },
      });
  }
}
