import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { EmergencyType } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { ControlRoom } from '../control-room/control-room';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import {
  emergencyNotFound,
  EmergencyRecords,
  type EmergencyRecord,
} from './emergency-records';
import { SosCore } from './sos-core';
import { StaffEmergencyView } from './views/staff-emergency.views';

/** A guard's SOS, replayed as the responders' view (never the household's). */
export const GUARD_SOS_RESOURCE = 'guard_sos';

/**
 * A guard's SOS (ADR 0053): an emergency from the post of their open shift
 * (a gate or a zone) instead of a unit, with ADR 0047's flow, through the
 * staff's SOS core (SosCore, shared with the technician's; ADR 0067). One
 * open per post and type, decided under the post's emergency lock (a
 * repeat answers 200 with the open one). The guard who raised it may
 * cancel it, and never accepts it. A new one is the control room's alert
 * too (ADR 0068), in the same transaction; a repeat is not.
 */
@Injectable()
export class GuardSosService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly idempotency: IdempotencyService,
    private readonly shifts: ShiftsService,
    private readonly core: SafetyCore,
    private readonly records: EmergencyRecords,
    private readonly sos: SosCore,
    private readonly controlRoom: ControlRoom,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(GUARD_SOS_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        StaffEmergencyView.from(
          await this.records.load(
            tx,
            await tx.emergency.findUniqueOrThrow({ where: { id } }),
          ),
          this.ctx.accountId,
        ),
      ),
    );
  }

  raise(
    type: EmergencyType,
  ): Promise<{ record: EmergencyRecord; created: boolean }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      // A guard's shift FOR SHARE (ADR 0056's lock order): its end waits
      // for the SOS, or came first and the guard is refused.
      const shift = await this.shifts.requireOnDutyLocked(tx);
      await this.core.lockUnit(
        tx,
        'emergency-post',
        shift.gateId ?? shift.placeId!,
      );
      const raised = await this.sos.raiseLocked(
        tx,
        {
          kind: 'post',
          gateId: shift.gateId,
          placeId: shift.placeId,
          shiftId: shift.id,
        },
        type,
        GUARD_SOS_RESOURCE,
      );
      if (raised.created)
        await this.controlRoom.publish(tx, {
          kind: 'guard_sos_raised',
          source: { type: 'emergency', id: raised.record.emergency.id },
          gateId: shift.gateId,
          placeId: shift.placeId,
          shiftId: shift.id,
        });
      return raised;
    });
  }

  /**
   * The guard who raised it cancels it while open, with an `emergencyCancel`
   * code or none. Its responder is told; with none yet, everyone who was.
   */
  cancel(id: string, reasonCode?: string): Promise<EmergencyRecord> {
    const reason =
      reasonCode === undefined
        ? null
        : requireReasonCodeOnly(reasonCode, REASON_CODES.emergencyCancel);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const e = await this.records.lock(tx, id, 'update');
      if (e.unitId || e.originTicketId || e.reportedById !== this.ctx.accountId)
        throw emergencyNotFound();
      return this.sos.cancelLocked(tx, e, reason);
    });
  }
}
