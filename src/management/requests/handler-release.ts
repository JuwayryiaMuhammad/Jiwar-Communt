import { Injectable, type OnModuleInit } from '@nestjs/common';
import { RoleLifecycle } from '../../core/access/role-lifecycle';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { REASON_CODES } from '../../core/common/reasons';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/** Why the system took requests back from a handler. */
export type ReleaseReason =
  (typeof REASON_CODES.managementRequestRelease)[number];

/**
 * A handler who can no longer handle requests gives theirs back to the
 * unassigned queue (ADR 0039), in the transaction of that change: the
 * account was deactivated, frozen or erased, or its role lost
 * `requests.handle`. Each live request is audited as unassigned by whoever
 * made the change, with the reason code. Closed requests keep the name of
 * who handled them.
 *
 * Locks: the account's row is held by the caller (a deactivation, a freeze,
 * an erasure) or taken here `FOR NO KEY UPDATE` for a role's accounts, then
 * the requests — the order of an assignment, which holds its assignee `FOR
 * SHARE`: one in flight finishes first and is then released, and a later
 * one reads the permission again and is refused.
 */
@Injectable()
export class RequestHandlerRelease implements OnModuleInit {
  constructor(
    private readonly accounts: AccountLifecycle,
    private readonly roles: RoleLifecycle,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.accounts.onDeactivated(async (tx, account) => {
      await this.release(tx, [account.id], 'account_deactivated');
      return [];
    });
    this.accounts.onFrozen(async (tx, account) => {
      await this.release(tx, [account.id], 'account_frozen');
    });
    this.accounts.onErasing(async (tx, account) => {
      await this.release(tx, [account.id], 'account_erased');
      return [];
    });
    this.roles.onPermissionsChanged(async (tx, roleId, _added, removed) => {
      if (!removed.includes('requests.handle')) return [];
      const accounts = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM accounts WHERE role_id = ${roleId}::uuid
         ORDER BY id FOR NO KEY UPDATE`;
      await this.release(
        tx,
        accounts.map((a) => a.id),
        'role_lost',
      );
      return [];
    });
  }

  /** Returns how many requests went back to the queue. */
  async release(
    tx: TenantTxClient,
    accountIds: readonly string[],
    reason: ReleaseReason,
  ): Promise<number> {
    if (!accountIds.length) return 0;
    const held = await tx.$queryRaw<
      { id: string; number: number; assignee: string }[]
    >`
      SELECT id, number, assignee_account_id AS assignee
        FROM management_requests
       WHERE assignee_account_id::text = ANY(${[...accountIds]}::text[])
         AND status <> 'closed'
       ORDER BY id FOR UPDATE`;
    for (const request of held) {
      await tx.managementRequest.update({
        where: { id: request.id },
        data: { assigneeId: null },
      });
      await this.audit.record(tx, {
        action: 'management_request.unassigned',
        targetId: request.id,
        changes: { assigneeId: { from: request.assignee, to: null } },
        metadata: { requestNumber: request.number, reasonCode: reason },
      });
    }
    return held.length;
  }
}
