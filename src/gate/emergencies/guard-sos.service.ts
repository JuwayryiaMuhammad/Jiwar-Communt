import { HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import type { EmergencyType } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import { EmergencyEscalation } from './emergency-escalation';
import {
  emergencyClosed,
  emergencyNotFound,
  EmergencyRecords,
  OPEN_EMERGENCY,
  type EmergencyRecord,
} from './emergency-records';
import { StaffEmergencyView } from './views/staff-emergency.views';

/** A guard's SOS, replayed as the responders' view (never the household's). */
export const GUARD_SOS_RESOURCE = 'guard_sos';

/**
 * A guard's SOS (ADR 0053): an emergency from the post of their open shift
 * (a gate or a zone) instead of a unit, with ADR 0047's flow. Nobody's
 * family is alerted. One open per post and type, decided under the post's
 * emergency lock (a repeat answers 200 with the open one). The other guards
 * on shift and the `emergencies.respond` holders are told at once, the
 * management (`emergencies.manage`) too; with no responder there, the
 * management gets it as an escalation instead. The guard who raised it may
 * cancel it, and never accepts it.
 */
@Injectable()
export class GuardSosService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly shifts: ShiftsService,
    private readonly core: SafetyCore,
    private readonly records: EmergencyRecords,
    private readonly escalation: EmergencyEscalation,
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
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const shift = await this.shifts.requireOnDuty(tx);
      const post = shift.gateId
        ? { originGateId: shift.gateId }
        : { originPlaceId: shift.placeId! };
      await this.core.lockUnit(
        tx,
        'emergency-post',
        shift.gateId ?? shift.placeId!,
      );
      const open = await tx.emergency.findFirst({
        where: { ...post, type, status: { in: OPEN_EMERGENCY } },
      });
      if (open) {
        await this.idempotency.claim(
          tx,
          { type: GUARD_SOS_RESOURCE, id: open.id },
          HttpStatus.OK,
        );
        return { record: await this.records.load(tx, open), created: false };
      }
      const id = newId();
      await this.idempotency.claim(tx, { type: GUARD_SOS_RESOURCE, id });
      const responders = [
        ...new Set([
          ...(await this.core.guardsOnShift(tx)),
          ...(await this.core.holding(tx, 'emergencies.respond')),
        ]),
      ].filter((a) => a !== me);
      const number = await this.core.nextNumber(tx, 'emergency');
      let emergency = await tx.emergency.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          number,
          ...post,
          originShiftId: shift.id,
          type,
          reportedById: me,
          respondersNotified: responders.length,
        },
      });
      await this.audit.record(tx, {
        action: 'emergency.reported',
        targetId: id,
        metadata: {
          number,
          type,
          unitId: null,
          gateId: shift.gateId,
          placeId: shift.placeId,
          shiftId: shift.id,
          respondersNotified: responders.length,
          familyNotified: 0,
        },
      });
      if (responders.length) {
        const managers = await this.core.holding(tx, 'emergencies.manage');
        await this.core.notify(
          tx,
          [...responders, ...managers],
          'emergency.reported',
          id,
          { emergencyType: type },
          me,
        );
      } else
        emergency = await this.escalation.escalate(
          tx,
          emergency,
          'no_responders',
        );
      return { record: await this.records.load(tx, emergency), created: true };
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
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const e = await this.records.lock(tx, id, 'update');
      if (e.unitId || e.reportedById !== me) throw emergencyNotFound();
      if (!OPEN_EMERGENCY.includes(e.status)) throw emergencyClosed(e.status);
      const cancelled = await tx.emergency.update({
        where: { id },
        data: {
          status: 'cancelled',
          closedAt: await dbNow(tx),
          closedById: me,
          closeSide: 'reporter',
          closeReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'emergency.cancelled',
        targetId: id,
        metadata: { from: e.status, reasonCode: reason },
      });
      const told = e.responderId
        ? [e.responderId]
        : [
            ...(await this.core.guardsOnShift(tx)),
            ...(await this.core.holding(tx, 'emergencies.respond')),
            ...(await this.core.holding(tx, 'emergencies.manage')),
          ];
      await this.core.notify(tx, told, 'emergency.cancelled', id, {}, me);
      return this.records.load(tx, cancelled);
    });
  }
}
