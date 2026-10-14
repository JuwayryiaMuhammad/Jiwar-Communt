import { Injectable } from '@nestjs/common';
import { RequestContext } from '../core/common/cls/request-context';
import { appError, ErrorCode } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The locks every facilities write starts with (ADR 0044), always in this
 * order: the caller's account row, then the unit's advisory lock, then the
 * facility's row, then a membership's row, then a slot's lock row, then
 * bookings' rows (by id). No booking path takes a unit's row: the
 * community writes that lock it (a member removed, an occupancy ended) then
 * reach for accounts, so a unit row lock here would cycle with them.
 */
@Injectable()
export class FacilitiesAccess {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * The caller's own account row, shared-locked for the rest of the
   * transaction (ADR 0039): an erasure, which locks it first, either
   * finished before and the caller is refused, or waits until this write
   * has committed and then cancels what it made.
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
   * One unit's bookings, decided by one writer at a time: its quota at
   * every facility and its suspension are counted and then written under
   * this lock, so two bookings at once cannot both be the last one
   * allowed, and a booking and a no-show that suspends the unit go one
   * after the other. Held to the end of the transaction.
   */
  async lockUnit(tx: TenantTxClient, unitId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`facility-unit:${this.ctx.txTenantId}:${unitId}`}))`;
  }
}
