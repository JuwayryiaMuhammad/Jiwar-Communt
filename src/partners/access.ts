import { Injectable } from '@nestjs/common';
import { RequestContext } from '../core/common/cls/request-context';
import { appError, ErrorCode } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The locks every partners write starts with (ADR 0060), always in this
 * order: the accounts (the caller's, or a request's requester, FOR SHARE),
 * then an account's advisory lock (its favourites, its live requests),
 * then the partner's row (FOR SHARE by a request; FOR UPDATE by a change
 * of the partner and by its suspension), then the settings row, then a
 * request's row, then the gate's own locks (the unit's, the pass's). No
 * partners path takes a unit's row.
 */
@Injectable()
export class PartnersAccess {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * The caller's own account row, shared-locked for the rest of the
   * transaction (ADR 0039): an erasure, which locks it first, either
   * finished before and the caller is refused, or waits until this write
   * has committed and then cancels what it made.
   */
  async lockSelf(tx: TenantTxClient): Promise<void> {
    if (!(await this.lockAccount(tx, this.ctx.accountId)))
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }

  /**
   * Another account's row, shared-locked: a request's requester, when the
   * partner's desk, the relay or the system acts on it. Whether it is
   * active.
   */
  async lockAccount(tx: TenantTxClient, accountId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${accountId}::uuid FOR SHARE`;
    return rows[0]?.status === 'active';
  }

  /**
   * One account's quota, decided by one writer at a time: its favourites
   * and its live requests are counted and then written under this lock
   * (the account's row is only shared, so two writes of the same account
   * would otherwise both count before either inserts).
   */
  async lockQuota(tx: TenantTxClient, accountId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`partner-account:${this.ctx.txTenantId}:${accountId}`}))`;
  }
}
