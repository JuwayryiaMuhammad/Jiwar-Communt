import { Injectable } from '@nestjs/common';
import { RequestContext } from '../core/common/cls/request-context';
import { appError, ErrorCode } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The locks every money event takes (ADR 0046), always in this order:
 *
 * 1. the caller's account row, shared (staff and residents; the webhook and
 *    the sweeps have no account);
 * 2. the compound's finance lock: shared by every event on one unit,
 *    exclusive by an issue to many units (one lock, however many units);
 * 3. each unit's finance lock, exclusive, in unit id order.
 *
 * Two-key advisory locks (their own key space, apart from the one-key locks
 * of other domains), not the units' rows: community writes lock a unit row and
 * then reach for accounts, so a unit row lock taken after an account here
 * would cycle with them (as ADR 0044 found for bookings). Everything that
 * reads and then writes what a unit owes — issue, credit note, payment,
 * reversal, allocation, a checkout — holds its unit's lock to the end of the
 * transaction, so two writers never decide on the same balance.
 */
@Injectable()
export class FinanceAccess {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * The caller's own account row, shared-locked: an erasure, which locks it
   * first, either finished before and the caller is refused, or waits for
   * this write.
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

  /** Events on some units: the compound shared, then each unit, in order. */
  async lockUnits(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<void> {
    const tenantId = this.ctx.txTenantId;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock_shared(hashtext('finance'), hashtext(${tenantId}))`;
    for (const unitId of [...new Set(unitIds)].sort()) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`finance-unit:${tenantId}`}), hashtext(${unitId}))`;
    }
  }

  /** An issue to many units: the compound's lock, exclusive. */
  async lockCompound(tx: TenantTxClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext('finance'), hashtext(${this.ctx.txTenantId}))`;
  }
}
