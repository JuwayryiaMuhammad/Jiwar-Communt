import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * A vendor's contractor acting (ADR 0088). Its vendor is read from its own
 * account row, shared-locked for the rest of the transaction, on the
 * contractor's routes only: never a query added to every request. An
 * erasure (which locks the row first) either finished before, and the
 * caller is refused, or waits for this write; a deactivation likewise.
 */
@Injectable()
export class ContractorAccess {
  constructor(private readonly ctx: RequestContext) {}

  /** The caller's vendor, the account row locked; 401 when it is not active. */
  async lockSelf(tx: TenantTxClient): Promise<{ vendorId: string }> {
    const rows = await tx.$queryRaw<
      { status: string; type: string; vendor_id: string | null }[]
    >`
      SELECT status::text AS status, type::text AS type, vendor_id
        FROM accounts WHERE id = ${this.ctx.accountId}::uuid FOR SHARE`;
    const me = rows[0];
    if (me?.status !== 'active')
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
    // The permission catalog keeps the contractor's permissions to its kind,
    // and the kind always has a vendor (a CHECK): this is a backstop.
    if (me.type !== 'contractor' || !me.vendor_id)
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Missing permission for this action',
      );
    return { vendorId: me.vendor_id };
  }

  /** The caller's vendor, read without a lock (a read route). */
  async vendorOf(tx: TenantTxClient): Promise<string> {
    const me = await tx.account.findUnique({
      where: { id: this.ctx.accountId },
      select: { type: true, vendorId: true },
    });
    if (me?.type !== 'contractor' || !me.vendorId)
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Missing permission for this action',
      );
    return me.vendorId;
  }
}

/**
 * A vendor's contractors who may be told of its work (ADR 0088): active,
 * holding the permission on their own role.
 */
export async function contractorsOf(
  tx: TenantTxClient,
  vendorId: string,
  permission: 'tickets.contract_work' | 'tenders.bid',
): Promise<string[]> {
  const rows = await tx.account.findMany({
    where: {
      vendorId,
      type: 'contractor',
      status: 'active',
      role: { permissions: { some: { permission } } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => r.id);
}
