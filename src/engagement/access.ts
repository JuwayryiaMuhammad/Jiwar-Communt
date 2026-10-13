import { Injectable } from '@nestjs/common';
import { RequestContext } from '../core/common/cls/request-context';
import { appError, ErrorCode } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';

/**
 * The caller's own account row, shared-locked for the rest of the
 * transaction (as the management requests do, ADR 0039): an erasure, which
 * locks it first, either finished before and the caller is refused, or
 * waits until this write has committed and then clears it with the rest
 * (ADR 0023). Always taken first: account row, then a unit, then the
 * content's own row.
 */
@Injectable()
export class EngagementAccess {
  constructor(private readonly ctx: RequestContext) {}

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
}
