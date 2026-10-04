import { Injectable, type OnModuleInit } from '@nestjs/common';
import { RoleLifecycle } from '../../core/access/role-lifecycle';
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
 * Locks: the dispatch lock first, then the role's account rows `FOR NO KEY
 * UPDATE` (an assignment in flight holds its technician `FOR SHARE`, so it
 * finishes first and is then released, and a later one re-reads the
 * permission and is refused), then the tickets.
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

  /** The hook: only the loss of `tickets.work` matters here. */
  async roleChanged(
    tx: TenantTxClient,
    roleId: string,
    removed: readonly string[],
  ): Promise<void> {
    if (!removed.includes('tickets.work')) return;
    await this.engine.serialize(tx);
    const accounts = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM accounts WHERE role_id = ${roleId}::uuid
       ORDER BY id FOR NO KEY UPDATE`;
    await this.revoke(
      tx,
      accounts.map((a) => a.id),
    );
  }

  /**
   * The backstop: whoever holds tickets in hand without being an active
   * staff account that holds `tickets.work` (whatever the cause, a sync of
   * the catalog included) loses them now. Returns how many tickets went
   * back to the queue.
   */
  async reconcile(tx: TenantTxClient): Promise<number> {
    await this.engine.serialize(tx);
    const holders = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT t.technician_account_id AS id
        FROM tickets t
       WHERE t.status::text = ANY(${[...IN_HAND]}::text[])
         AND t.technician_account_id IS NOT NULL
       ORDER BY 1`;
    let released = 0;
    for (const { id } of holders) {
      // Locked, then looked at again: a role restored in the meantime is fine.
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
      const qualified = await tx.account.count({
        where: {
          id,
          status: 'active',
          type: 'staff',
          role: { permissions: { some: { permission: 'tickets.work' } } },
        },
      });
      if (!qualified) released += await this.revoke(tx, [id]);
    }
    return released;
  }

  private async revoke(
    tx: TenantTxClient,
    accountIds: readonly string[],
  ): Promise<number> {
    const released: string[] = [];
    for (const id of accountIds) {
      await this.availability.markUnavailable(tx, id, 'permission_lost');
      released.push(...(await this.release.release(tx, id)));
    }
    for (const id of released) await this.engine.attempt(tx, id, 'role_lost');
    return released.length;
  }
}
