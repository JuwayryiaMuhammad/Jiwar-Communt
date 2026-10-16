import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type UnitPermit } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';
import { PermitCore } from './permit-core';

/**
 * What happens to an account's permits when it goes (ADR 0049), in the
 * transaction of what made it go, which holds the account's row:
 *
 * - **It no longer has a place in the unit** (it left, its occupancy ended,
 *   it was removed from the household), or **may no longer invite visitors**
 *   there (an event's host), or is **deactivated** or **erased** (an erasure
 *   deactivates first): its live permits there — pending, or approved and
 *   not ended — are cancelled by the system (`requester_left`), and the
 *   unit's primary is told. Losing only the primary role keeps them: the
 *   work is the unit's, and the new primary may cancel it.
 * - **Erased**: what it wrote goes — a works description and its
 *   contractor's company, a move's items, a material exit's items and
 *   photo, an event's title — once, together (`text_cleared_at`). The
 *   permits stay, pointing at the tombstone, with the management's notes.
 *   Its workers' and guests' names go with the purge, 30 days after the
 *   permit ended (or was cancelled).
 *
 * Locks: permit rows by id, FOR UPDATE; never a unit's lock or row.
 */
@Injectable()
export class PermitLifecycle implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityGatePort,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly core: PermitCore,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.requesterLeft(tx, account.id, () => Promise.resolve(true));
      return [];
    });
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      await this.requesterLeft(tx, account.id, async (p) => {
        const caps = await this.community.placeIn(tx, account.id, p.unitId);
        return p.kind === 'event' ? !caps?.visitorsInvite : !caps;
      });
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.requesterLeft(tx, account.id, () => Promise.resolve(true));
      await this.forget(tx, account.id);
      return [];
    });
  }

  /** Its live permits for which `gone` holds, cancelled by the system. */
  private async requesterLeft(
    tx: TenantTxClient,
    accountId: string,
    gone: (p: UnitPermit) => Promise<boolean>,
  ): Promise<void> {
    const now = await dbNow(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM unit_permits
       WHERE requested_by_account_id = ${accountId}::uuid
         AND (status = 'pending'
              OR (status = 'approved' AND ends_at > ${now}))
       ORDER BY id FOR UPDATE`;
    for (const { id } of rows) {
      const p = await tx.unitPermit.findUniqueOrThrow({ where: { id } });
      if (!(await gone(p))) continue;
      await tx.unitPermit.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: now,
          cancelSide: 'system',
          cancelReason: 'requester_left',
        },
      });
      await this.audit.record(tx, {
        action: 'unit_permit.cancelled',
        targetId: id,
        metadata: {
          kind: p.kind,
          unitId: p.unitId,
          from: p.status,
          side: 'system',
          reasonCode: 'requester_left',
        },
      });
      await this.core.notify(
        tx,
        [await this.core.primaryOf(tx, p.unitId)],
        'unit_permit.cancelled',
        id,
        { permitKind: p.kind, reason: 'requester_left' },
        accountId,
      );
    }
  }

  /** What the erased account wrote, and its photos. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM unit_permits
       WHERE requested_by_account_id = ${accountId}::uuid
         AND text_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      const before = await tx.unitPermit.findUniqueOrThrow({ where: { id } });
      await tx.unitPermit.update({
        where: { id },
        data: {
          contractorCompany: null,
          description: null,
          itemsDescription: null,
          items: Prisma.DbNull,
          title: null,
          photoFileId: null,
          textClearedAt: now,
        },
      });
      if (before.photoFileId)
        await this.files.markDeleted(
          tx,
          { id: before.photoFileId, purpose: 'permit_photo' },
          'erasure',
        );
      await this.audit.record(tx, {
        action: 'unit_permit.text_cleared',
        targetId: id,
        metadata: {
          kind: before.kind,
          contractorCompany: before.contractorCompany !== null,
          description: before.description !== null,
          itemsDescription: before.itemsDescription !== null,
          items: before.items !== null,
          title: before.title !== null,
          photo: before.photoFileId !== null,
        },
      });
    }
  }
}
