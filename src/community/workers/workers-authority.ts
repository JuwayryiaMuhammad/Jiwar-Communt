import { Injectable } from '@nestjs/common';
import type { WorkerEngagement } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { AppException, appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  HouseholdAuthority,
  type Authority,
} from '../households/household-authority';

/**
 * Who may act on a unit's domestic workers (ADR 0017), on top of
 * `workers.manage` / `workers.review`:
 *
 * - register: an occupant of the unit (any active occupancy, not only the
 *   primary), or a delegate with the `workers` scope. A plain household
 *   member cannot;
 * - suspend, resume, end, reissue: the engagement's requester (while they
 *   can still see the unit), the unit's primary, a `workers` delegate, or a
 *   manager.
 */
@Injectable()
export class WorkersAuthority {
  constructor(
    private readonly ctx: RequestContext,
    private readonly household: HouseholdAuthority,
  ) {}

  assertVisible(tx: TenantTxClient, unitId: string): Promise<void> {
    return this.household.assertVisible(tx, unitId);
  }

  async forRegister(tx: TenantTxClient, unitId: string): Promise<Authority> {
    const accountId = this.ctx.accountId;
    await this.household.assertVisible(tx, unitId);
    if (await this.occupies(tx, unitId, accountId)) {
      return { accountId, onBehalfOf: null };
    }
    return this.viaDelegation(tx, unitId);
  }

  async forEngagement(
    tx: TenantTxClient,
    e: WorkerEngagement,
  ): Promise<Authority> {
    const accountId = this.ctx.accountId;
    if (this.ctx.accountType === 'manager') {
      return { accountId, onBehalfOf: null };
    }
    await this.household.assertVisible(tx, e.unitId);
    if (e.requestedById === accountId) return { accountId, onBehalfOf: null };
    return this.viaDelegation(tx, e.unitId);
  }

  /** The primary, or a live `workers` delegate — anyone else is refused. */
  private async viaDelegation(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<Authority> {
    try {
      return await this.household.require(tx, unitId, 'workers');
    } catch (error) {
      if (
        error instanceof AppException &&
        error.code === ErrorCode.NOT_PRIMARY_RESIDENT
      ) {
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          "Only the unit's occupants or a delegate can manage its workers",
        );
      }
      throw error;
    }
  }

  private async occupies(
    tx: TenantTxClient,
    unitId: string,
    accountId: string,
  ): Promise<boolean> {
    return (
      (await tx.unitOccupancy.count({
        where: { unitId, accountId, status: 'active' },
      })) > 0
    );
  }
}
