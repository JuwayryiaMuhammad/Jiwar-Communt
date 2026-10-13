import { Injectable } from '@nestjs/common';
import { RequestContext } from '../core/common/cls/request-context';
import { appError, ErrorCode } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The locks every neighbours write starts with (ADR 0042), always in this
 * order: the caller's account row, then an advisory lock, then the
 * record's own row, then the settings row.
 */
@Injectable()
export class NeighbourAccess {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * The caller's own account row, shared-locked for the rest of the
   * transaction (as the management requests do, ADR 0039): an erasure,
   * which locks it first, either finished before and the caller is
   * refused, or waits until this write has committed and then clears it
   * with the rest (ADR 0023).
   */
  async lockSelf(tx: TenantTxClient): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${this.ctx.accountId}::uuid FOR SHARE`;
    if (rows[0]?.status !== 'active')
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }

  /**
   * One account's quota, counted by one writer at a time: what the account
   * may have open, or start in a day, is counted and then written under
   * this lock, so two requests at once cannot both be the last one
   * allowed. Held to the end of the transaction.
   */
  async lockQuota(tx: TenantTxClient, accountId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`neighbour-quota:${this.ctx.txTenantId}:${accountId}`}))`;
  }

  /**
   * Two accounts, whatever the order they are named in: a block between
   * them and a new conversation between them are decided one at a time.
   * Taken after `lockQuota`.
   */
  async lockPair(tx: TenantTxClient, a: string, b: string): Promise<void> {
    const [low, high] = a < b ? [a, b] : [b, a];
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`neighbour-pair:${this.ctx.txTenantId}:${low}:${high}`}))`;
  }
}
