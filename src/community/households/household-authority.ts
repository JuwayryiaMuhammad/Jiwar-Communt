import { Injectable } from '@nestjs/common';
import type { DelegationScope } from '@prisma/client';
import { ResourceAccess } from '../../core/access/resource-access';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

export interface Authority {
  /** The acting account. */
  accountId: string;
  /** Set when a delegate acts: the primary resident it acts for. */
  onBehalfOf: string | null;
}

/**
 * Resource-level check for household and worker actions (ADR 0016), on top
 * of the permission: the unit's primary resident, or a delegate whose
 * delegation is live, unexpired and includes the scope.
 *
 * - The unit must first be visible to the caller (ResourceAccess),
 *   otherwise it is "not found" like any unit they cannot see.
 * - Expiry is checked here, at use time: there is no job that ends
 *   delegations on their date.
 * - A delegate acts `onBehalfOf` the primary; callers put that in the audit
 *   metadata.
 */
@Injectable()
export class HouseholdAuthority {
  constructor(
    private readonly ctx: RequestContext,
    private readonly access: ResourceAccess,
  ) {}

  async require(
    tx: TenantTxClient,
    unitId: string,
    scope: DelegationScope,
  ): Promise<Authority> {
    const accountId = this.ctx.accountId;
    await this.assertVisible(tx, unitId);
    if (await isPrimary(tx, unitId, accountId)) {
      return { accountId, onBehalfOf: null };
    }
    const delegation = await tx.householdDelegation.findFirst({
      where: {
        unitId,
        delegateAccountId: accountId,
        revokedAt: null,
        scopes: { has: scope },
      },
    });
    if (!delegation) throw notPrimary();
    if (delegation.expiresAt <= new Date()) {
      throw appError.forbidden(
        ErrorCode.DELEGATION_EXPIRED,
        'Your delegation for this unit has expired',
      );
    }
    // Automatic ends keep this true; checked anyway, it is cheap.
    if (!(await isPrimary(tx, unitId, delegation.delegatorAccountId))) {
      throw notPrimary();
    }
    return { accountId, onBehalfOf: delegation.delegatorAccountId };
  }

  /** The unit as the caller may see it, inside the transaction. */
  async assertVisible(tx: TenantTxClient, unitId: string): Promise<void> {
    const unit = await tx.unit.findFirst({
      where: { AND: [{ id: unitId }, this.access.unitScope()] },
      select: { id: true },
    });
    if (!unit)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
  }
}

export async function isPrimary(
  tx: TenantTxClient,
  unitId: string,
  accountId: string,
): Promise<boolean> {
  return (
    (await tx.unitOccupancy.count({
      where: { unitId, accountId, status: 'active', isPrimary: true },
    })) > 0
  );
}

export function notPrimary() {
  return appError.forbidden(
    ErrorCode.NOT_PRIMARY_RESIDENT,
    "Only the unit's primary resident can do this",
  );
}
