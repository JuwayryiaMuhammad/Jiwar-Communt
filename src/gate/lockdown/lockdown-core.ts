import { Injectable } from '@nestjs/common';
import type { GateLockdown } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

export type LockdownScope = 'gate' | 'all';

export const scopeOf = (l: { gateId: string | null }): LockdownScope =>
  l.gateId ? 'gate' : 'all';

export const lockdownActive = (l: { gateId: string | null }) =>
  appError.conflict(
    ErrorCode.LOCKDOWN_ACTIVE,
    'The gate is locked down: only residents come in',
    { params: { scope: scopeOf(l) } },
  );

/**
 * The lockdown of the gates (ADR 0053), what every gate path shares.
 *
 * **One row decides.** `gate_lockdown_states` holds one row per compound.
 * A start and an end take it FOR UPDATE; a verify, an entry in, a gate
 * request and a material entry take it FOR SHARE before anything of their
 * subject. A start therefore waits for the entries in flight, and every
 * entry after it sees the lockdown. Its `started_at` is the database's
 * clock read after that lock.
 *
 * **Lock order:** the account (FOR SHARE), the shift, this row, then the
 * subject's rows. A lockdown writer takes nothing else after the row.
 */
@Injectable()
export class LockdownCore {
  constructor(private readonly ctx: RequestContext) {}

  /** The compound's lockdown row, FOR UPDATE (a start, an end) or FOR SHARE. */
  async lockState(tx: TenantTxClient, mode: 'update' | 'share'): Promise<void> {
    const tenantId = this.ctx.txTenantId;
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<{ tenant_id: string }[]>`
            SELECT tenant_id FROM gate_lockdown_states
             WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`
        : await tx.$queryRaw<{ tenant_id: string }[]>`
            SELECT tenant_id FROM gate_lockdown_states
             WHERE tenant_id = ${tenantId}::uuid FOR SHARE`;
    // Provisioned with every compound and backfilled: a missing row is a bug.
    if (!rows.length)
      throw new Error(`No lockdown state row for compound ${tenantId}`);
  }

  /** The live lockdown holding the gate now: its own first, else the "all" one. */
  live(tx: TenantTxClient, gateId: string): Promise<GateLockdown | null> {
    return tx.gateLockdown.findFirst({
      where: { endedAt: null, OR: [{ gateId }, { gateId: null }] },
      orderBy: { gateId: { sort: 'asc', nulls: 'last' } },
    });
  }

  /**
   * A lockdown holding the gate for an entry that happened at `at`: one
   * live now (an entry recorded during it is refused, whenever it says it
   * happened), or one that held at `at` (an entry recorded late, ADR 0028:
   * checked again at the moment it happened). Null when none.
   */
  async holding(
    tx: TenantTxClient,
    gateId: string,
    at: Date,
  ): Promise<GateLockdown | null> {
    return (
      (await this.live(tx, gateId)) ??
      tx.gateLockdown.findFirst({
        where: {
          OR: [{ gateId }, { gateId: null }],
          startedAt: { lte: at },
          endedAt: { gt: at },
        },
      })
    );
  }

  /**
   * What an entry in, a gate request or a material entry asks first: the
   * row FOR SHARE, then 409 LOCKDOWN_ACTIVE when a lockdown holds the gate.
   */
  async refuseIn(tx: TenantTxClient, gateId: string, at: Date): Promise<void> {
    await this.lockState(tx, 'share');
    const lockdown = await this.holding(tx, gateId, at);
    if (lockdown) throw lockdownActive(lockdown);
  }
}
