import { Injectable } from '@nestjs/common';
import type { ManagementRequest } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Who reads a request, and so which view and which rules apply (ADR 0039).
 * Each side has its own routes: the author (`requests.create`) and the
 * staff (`requests.handle`).
 */
export type Audience = 'resident' | 'staff';

export const requestNotFound = () =>
  appError.notFound(
    ErrorCode.MANAGEMENT_REQUEST_NOT_FOUND,
    'Management request not found',
  );

/**
 * Loads a request for an audience, or MANAGEMENT_REQUEST_NOT_FOUND: one
 * answer for an unknown id, another compound's request (RLS) and one the
 * caller may not see.
 *
 * - on the resident side a request is its author's alone: not the unit's,
 *   not the household's. The primary resident does not see a family
 *   member's request, and nobody sees another's by its id;
 * - staff see every request of the compound.
 *
 * Writes lock the row first (`FOR UPDATE`) and check after the lock, so a
 * request that lost a race sees the winner's commit. Locks are always
 * taken account row first, then the request, then an appointment slot.
 */
@Injectable()
export class RequestAccess {
  constructor(private readonly ctx: RequestContext) {}

  async load(
    tx: TenantTxClient,
    id: string,
    audience: Audience,
    opts: { lock?: boolean } = {},
  ): Promise<ManagementRequest> {
    if (opts.lock)
      await tx.$queryRaw`SELECT id FROM management_requests WHERE id = ${id}::uuid FOR UPDATE`;
    const request = await tx.managementRequest.findUnique({ where: { id } });
    if (!request || !this.sees(request, audience)) throw requestNotFound();
    return request;
  }

  sees(request: Pick<ManagementRequest, 'authorId'>, audience: Audience) {
    return audience === 'staff' || request.authorId === this.ctx.accountId;
  }

  /**
   * The caller's own account row, shared-locked for the rest of the
   * transaction: an erasure (which locks it first) either finished before,
   * and the caller is refused, or waits until this write has committed and
   * then clears it with the rest (ADR 0023, as tickets do).
   */
  async lockSelf(tx: TenantTxClient): Promise<void> {
    if (!(await this.lockActive(tx, this.ctx.accountId)))
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
  }

  /**
   * Another account's row, shared-locked (an author staff write for, an
   * assignee): whether it is active now, and it stays so until the commit.
   */
  async lockActive(tx: TenantTxClient, accountId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM accounts
       WHERE id = ${accountId}::uuid FOR SHARE`;
    return rows[0]?.status === 'active';
  }
}
