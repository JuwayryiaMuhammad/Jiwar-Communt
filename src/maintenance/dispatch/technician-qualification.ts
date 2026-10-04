import { Injectable, type OnModuleInit } from '@nestjs/common';
import { RoleLifecycle } from '../../core/access/role-lifecycle';
import type { AfterCommit } from '../../core/accounts/account-lifecycle';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TechnicianRelease } from '../tickets/technician-release';
import { IN_HAND } from '../tickets/ticket-rules';
import { AvailabilityService } from './availability.service';
import { DispatchEngine } from './dispatch-engine';

/**
 * Closes the 5.1 gap (ADR 0033): a technician whose role loses
 * `tickets.work` could not work, yet kept the tickets in their hands until a
 * dispatcher noticed. Now every account of that role leaves the pool
 * (`unavailable`, reason `permission_lost`), releases its open tickets back
 * to the queue (`released` / `technician_unavailable`, the dispatchers are
 * told), and the engine tries each released ticket again.
 *
 * Two ways in:
 * - the core hook (`RoleLifecycle`), in the transaction of the change:
 *   `PUT /roles/:id/permissions`, and `access:sync` when it runs inside the
 *   app;
 * - `reconcile`, from the dispatch sweep. `pnpm access:sync` is a deploy
 *   step that boots core only, so no domain handler is registered in that
 *   process; the sweep finds the technicians who no longer qualify instead.
 *
 * Locks: the role's account rows `FOR NO KEY UPDATE` (an assignment in
 * flight holds its technician `FOR SHARE`, so it finishes first and is then
 * released, and a later one re-reads the permission and is refused), then
 * the tickets. The dispatch lock is not taken here: the engine takes it for
 * each ticket it retries, after this transaction committed.
 */
@Injectable()
export class TechnicianQualification implements OnModuleInit {
  constructor(
    private readonly roles: RoleLifecycle,
    private readonly engine: DispatchEngine,
    private readonly availability: AvailabilityService,
    private readonly release: TechnicianRelease,
  ) {}

  onModuleInit(): void {
    this.roles.onPermissionsChanged((tx, roleId, _added, removed) =>
      this.roleChanged(tx, roleId, removed),
    );
  }

  /**
   * The hook: only the loss of `tickets.work` matters here. Releases in the
   * changing transaction (the role's accounts locked `FOR NO KEY UPDATE`, in
   * id order, then their tickets), and hands the released tickets to the
   * engine after it commits: the engine's decisions take the dispatch lock,
   * which a role edit must not wait for.
   */
  async roleChanged(
    tx: TenantTxClient,
    roleId: string,
    removed: readonly string[],
  ): Promise<AfterCommit[]> {
    if (!removed.includes('tickets.work')) return [];
    const accounts = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM accounts WHERE role_id = ${roleId}::uuid
       ORDER BY id FOR NO KEY UPDATE`;
    const released = await this.revoke(
      tx,
      accounts.map((a) => a.id),
    );
    return released.length
      ? [
          () =>
            this.engine
              .afterRelease(released, 'role_lost')
              .then(() => undefined),
        ]
      : [];
  }

  /**
   * The backstop's first half: whoever holds tickets in hand without being
   * an active staff account that holds `tickets.work` (whatever the cause, a
   * sync of the catalog included). No lock; `reconcileOne` takes it.
   */
  async unqualifiedHolders(tx: TenantTxClient): Promise<string[]> {
    const holders = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT t.technician_account_id AS id
        FROM tickets t
        JOIN accounts a ON a.id = t.technician_account_id
       WHERE t.status::text = ANY(${[...IN_HAND]}::text[])
         AND NOT (a.status = 'active' AND a.type = 'staff'
                  AND EXISTS (SELECT 1 FROM role_permissions rp
                               WHERE rp.role_id = a.role_id
                                 AND rp.permission = 'tickets.work'))
       ORDER BY 1`;
    return holders.map((h) => h.id);
  }

  /**
   * The backstop's second half, in a transaction of its own: the account
   * locked, then looked at again (a role restored in the meantime is fine),
   * then released. Returns the ids of the tickets it released, which the
   * queue pass of the same sweep finds in the queue.
   */
  async reconcileOne(tx: TenantTxClient, accountId: string): Promise<number> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR NO KEY UPDATE`;
    const qualified = await tx.account.count({
      where: {
        id: accountId,
        status: 'active',
        type: 'staff',
        role: { permissions: { some: { permission: 'tickets.work' } } },
      },
    });
    if (qualified) return 0;
    return (await this.revoke(tx, [accountId])).length;
  }

  /** Each leaves the pool and releases what they hold; the released ids. */
  private async revoke(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<string[]> {
    const released: string[] = [];
    for (const id of accountIds) {
      await this.availability.markUnavailable(tx, id, 'permission_lost');
      released.push(...(await this.release.release(tx, id)));
    }
    return released;
  }
}
