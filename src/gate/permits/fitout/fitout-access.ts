import { Injectable } from '@nestjs/common';
import type { UnitPermit } from '@prisma/client';
import { RequestContext } from '../../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../../core/common/errors';
import type { TenantTxClient } from '../../../core/database/tenant-tx.service';
import { dbNow } from '../../db-clock';
import { PermitCore } from '../permit-core';
import {
  isOpen,
  permitNotFound,
  PermitRecords,
  viewStatus,
} from '../permit-records';

/** Who works on a permit's fit-out: its household, or the management. */
export type FitOutSide = 'resident' | 'staff';

/**
 * Who may reach a works permit's fit-out (ADR 0074), and the writers' lock
 * order. The household's side is the permit's requester or the unit's
 * primary now (the works are the unit's); the management's is whoever
 * holds `permits.manage`, which the routes check. Any other permit, or a
 * permit the caller has no part in, is the one not-found.
 *
 * Lock order, as the permits' (ADR 0049): the caller's account (FOR
 * SHARE), the unit's advisory lock (`permit-unit`), the permit's row (FOR
 * UPDATE), then the fit-out's own rows, a file's row, and last a counter.
 */
@Injectable()
export class FitOutAccess {
  constructor(
    private readonly ctx: RequestContext,
    private readonly core: PermitCore,
    private readonly records: PermitRecords,
  ) {}

  /** The works permit, as `side` may read it; nothing locked. */
  async read(
    tx: TenantTxClient,
    permitId: string,
    side: FitOutSide,
  ): Promise<UnitPermit> {
    const p = await tx.unitPermit.findUnique({ where: { id: permitId } });
    if (!p || p.kind !== 'works') throw permitNotFound();
    if (side === 'resident' && !(await this.isHousehold(tx, p)))
      throw permitNotFound();
    return p;
  }

  /**
   * The works permit for a write, in the lock order: the account, the
   * unit, the permit's row. `open`: refused unless it is pending, or
   * approved and not ended (PERMIT_NOT_ACTIVE, params.status).
   */
  async write(
    tx: TenantTxClient,
    permitId: string,
    side: FitOutSide,
    open: boolean,
  ): Promise<UnitPermit> {
    await this.core.lockSelf(tx);
    const peek = await this.read(tx, permitId, side);
    await this.core.lockUnit(tx, peek.unitId);
    const p = await this.records.lock(tx, permitId);
    if (open) {
      const now = await dbNow(tx);
      if (!isOpen(p, now))
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_ACTIVE,
          'The permit is not open',
          { params: { status: viewStatus(p, now) } },
        );
    }
    return p;
  }

  /** The requester, or the unit's primary now. */
  private async isHousehold(
    tx: TenantTxClient,
    p: UnitPermit,
  ): Promise<boolean> {
    return (
      p.requestedById === this.ctx.accountId ||
      (await this.core.isPrimary(tx, p.unitId))
    );
  }

  /** Whose the household's side is: the requester and the primary now. */
  async household(tx: TenantTxClient, p: UnitPermit): Promise<string[]> {
    const primary = await this.core.primaryOf(tx, p.unitId);
    return [...new Set([p.requestedById, ...(primary ? [primary] : [])])];
  }
}
