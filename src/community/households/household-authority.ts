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
 * Resource-level check for household actions (ADR 0016), on top of the
 * `household.manage` permission: only the unit's primary resident may
 * invite, add a minor, remove a member or revoke an invite.
 *
 * The unit must first be visible to the caller (ResourceAccess), otherwise
 * it is "not found" like any unit they cannot see.
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
    void scope; // delegates (ADR 0016, Part E) are checked per scope
    const accountId = this.ctx.accountId;
    await this.assertVisible(tx, unitId);
    if (await isPrimary(tx, unitId, accountId)) {
      return { accountId, onBehalfOf: null };
    }
    throw notPrimary();
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
