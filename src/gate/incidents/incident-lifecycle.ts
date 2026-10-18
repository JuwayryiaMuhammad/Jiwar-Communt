import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';

/**
 * What an erasure does to incidents (ADR 0053), in its transaction, which
 * holds the account's row: what the account wrote goes, once each,
 * audited by id —
 *
 * - **the reports it filed**: their description;
 * - **the incidents it closed**: the closing note;
 * - **its internal notes**: their words.
 *
 * The incidents stay as the compound's record: their type, severity,
 * place, unit, links, photos (they show a place), outcome and
 * acknowledgements; views show the erased account as `{ id, erased: true }`.
 * A deactivation changes nothing: an incident is the compound's, and an
 * investigator who left is replaced by assigning another.
 *
 * Locks: incident and note rows by id, FOR UPDATE.
 */
@Injectable()
export class IncidentLifecycle implements OnModuleInit {
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

  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const now = await dbNow(tx);
    const incidents = await tx.$queryRaw<
      { id: string; description: boolean; closing_note: boolean }[]
    >`
      SELECT id,
             (reported_by_account_id = ${accountId}::uuid
               AND description IS NOT NULL) AS description,
             (closed_by_account_id = ${accountId}::uuid
               AND closing_note IS NOT NULL) AS closing_note
        FROM incidents
       WHERE (reported_by_account_id = ${accountId}::uuid AND description IS NOT NULL)
          OR (closed_by_account_id = ${accountId}::uuid AND closing_note IS NOT NULL)
       ORDER BY id FOR UPDATE`;
    for (const i of incidents) {
      await tx.incident.update({
        where: { id: i.id },
        data: {
          ...(i.description ? { description: null, textClearedAt: now } : {}),
          ...(i.closing_note
            ? { closingNote: null, closingNoteClearedAt: now }
            : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'incident.text_cleared',
        targetId: i.id,
        metadata: { description: i.description, closingNote: i.closing_note },
      });
    }
    const notes = await tx.$queryRaw<{ id: string; incident_id: string }[]>`
      SELECT id, incident_id FROM incident_notes
       WHERE author_account_id = ${accountId}::uuid AND body IS NOT NULL
       ORDER BY id FOR UPDATE`;
    for (const n of notes) {
      await tx.incidentNote.update({
        where: { id: n.id },
        data: { body: null, textClearedAt: now },
      });
      await this.audit.record(tx, {
        action: 'incident_note.text_cleared',
        targetId: n.id,
        metadata: { incidentId: n.incident_id },
      });
    }
  }
}
