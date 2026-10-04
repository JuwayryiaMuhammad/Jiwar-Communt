import { Injectable } from '@nestjs/common';
import type { AfterCommit } from '../accounts/account-lifecycle';
import type { TenantTxClient } from '../database/tenant-tx.service';

/**
 * Called inside the transaction that changed a role's permissions, after the
 * writes and the version bump: what was `added` and what was `removed`.
 */
export type PermissionsChangedHandler = (
  tx: TenantTxClient,
  roleId: string,
  added: readonly string[],
  removed: readonly string[],
) => Promise<void | AfterCommit[]>;

/**
 * How core tells domains that a role's permissions changed, without
 * importing them (ADR 0015), the way AccountLifecycle does for accounts:
 * maintenance releases the tickets of technicians whose role loses
 * `tickets.work` (ADR 0033). Handlers run inside the changing transaction,
 * so their writes commit or roll back with the permission change, and may
 * hand back work to run after it commits (the engine retrying what they
 * released).
 *
 * Two paths change a role's permissions: `PUT /roles/:id/permissions` and
 * `access:sync`. An account never changes role after it is created, and
 * roles are never created or deleted through the API, so there is no other
 * path to hook.
 */
@Injectable()
export class RoleLifecycle {
  private readonly handlers: PermissionsChangedHandler[] = [];

  onPermissionsChanged(handler: PermissionsChangedHandler): void {
    this.handlers.push(handler);
  }

  async permissionsChanged(
    tx: TenantTxClient,
    roleId: string,
    added: readonly string[],
    removed: readonly string[],
  ): Promise<AfterCommit[]> {
    const tasks: AfterCommit[] = [];
    if (!added.length && !removed.length) return tasks;
    for (const handler of this.handlers)
      tasks.push(...((await handler(tx, roleId, added, removed)) ?? []));
    return tasks;
  }
}
