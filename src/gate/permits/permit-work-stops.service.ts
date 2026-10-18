import { Injectable } from '@nestjs/common';
import type { PermitWorkStop, UnitPermit } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import { PermitCore } from './permit-core';
import { PermitRecords, viewStatus, type PermitRecord } from './permit-records';

/**
 * Stop work (ADR 0053). A guard on shift (a gate or a zone), or the
 * permits' staff (`permits.manage`), stops the work of an approved works
 * permit in force, with a reason code: its workers are refused at the gate
 * (`work_stopped`) until the management resumes it, or the permit is
 * revoked or cancelled (which ends the stop with it).
 *
 * Every write takes the permit's row FOR UPDATE; a worker's entry takes it
 * FOR SHARE and reads the stop under it. So a stop and an entry meet in one
 * order: the entry committed first, or it is refused.
 */
@Injectable()
export class PermitWorkStopsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly core: PermitCore,
    private readonly records: PermitRecords,
  ) {}

  /** `side`: a guard on shift, or the permits' staff. */
  stop(
    id: string,
    reasonCodeIn: string,
    side: 'guard' | 'staff',
  ): Promise<PermitRecord> {
    const reasonCode = requireReasonCodeOnly(
      reasonCodeIn,
      REASON_CODES.permitWorkStop,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const shift =
        side === 'guard' ? await this.shifts.requireOnDuty(tx) : null;
      const p = await this.records.lock(tx, id);
      const now = await dbNow(tx);
      if (
        p.kind !== 'works' ||
        p.status !== 'approved' ||
        p.endsAt.getTime() <= now.getTime()
      )
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_ACTIVE,
          'Only the work of an approved works permit in force is stopped',
          { params: { status: viewStatus(p, now) } },
        );
      if (await this.live(tx, id))
        throw appError.conflict(
          ErrorCode.PERMIT_WORK_STOPPED,
          'The work is stopped already',
        );
      await tx.permitWorkStop.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          permitId: id,
          stoppedById: me,
          stoppedShiftId: shift?.id ?? null,
          reasonCode,
          stoppedAt: now,
        },
      });
      const household = await this.household(tx, p);
      const staff =
        side === 'guard' ? await this.safety.holding(tx, 'permits.manage') : [];
      const told = await this.safety.notify(
        tx,
        [...household, ...staff],
        'unit_permit.work_stopped',
        id,
        { reason: reasonCode },
        me,
      );
      await this.audit.record(tx, {
        action: 'permit_work.stopped',
        targetId: id,
        metadata: {
          reasonCode,
          side,
          shiftId: shift?.id ?? null,
          recipients: told,
        },
      });
      return this.records.load(tx, p);
    });
  }

  /** The management lets the work go on. */
  resume(id: string): Promise<PermitRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const p = await this.records.lock(tx, id);
      const stop = await this.live(tx, id);
      if (!stop)
        throw appError.conflict(
          ErrorCode.PERMIT_WORK_NOT_STOPPED,
          'The work is not stopped',
        );
      await tx.permitWorkStop.update({
        where: { id: stop.id },
        data: { endedAt: await dbNow(tx), endedById: me, endKind: 'resumed' },
      });
      const told = await this.safety.notify(
        tx,
        await this.household(tx, p),
        'unit_permit.work_resumed',
        id,
        {},
        me,
      );
      await this.audit.record(tx, {
        action: 'permit_work.resumed',
        targetId: id,
        metadata: { stopId: stop.id, recipients: told },
      });
      return this.records.load(tx, p);
    });
  }

  /**
   * A permit that ends (revoked, cancelled) ends its stop with it, in the
   * caller's transaction, which holds the permit's row.
   */
  async endWith(
    tx: TenantTxClient,
    permitId: string,
    kind: 'permit_revoked' | 'permit_cancelled',
    by: string | null,
  ): Promise<void> {
    await tx.permitWorkStop.updateMany({
      where: { permitId, endedAt: null },
      data: { endedAt: await dbNow(tx), endedById: by, endKind: kind },
    });
  }

  /** The permit's live stop, if any. */
  live(tx: TenantTxClient, permitId: string): Promise<PermitWorkStop | null> {
    return tx.permitWorkStop.findFirst({
      where: { permitId, endedAt: null },
    });
  }

  /** The requester and the unit's primary. */
  private async household(
    tx: TenantTxClient,
    p: UnitPermit,
  ): Promise<string[]> {
    const primary = await this.core.primaryOf(tx, p.unitId);
    return [...new Set([p.requestedById, ...(primary ? [primary] : [])])];
  }
}
