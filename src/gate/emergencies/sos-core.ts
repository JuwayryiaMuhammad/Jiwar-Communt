import { HttpStatus, Injectable } from '@nestjs/common';
import type { Emergency, EmergencyType } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { EmergencyEscalation } from './emergency-escalation';
import {
  emergencyClosed,
  EmergencyRecords,
  OPEN_EMERGENCY,
  type EmergencyRecord,
} from './emergency-records';

/**
 * Where a staff member's SOS comes from: a guard's post on their open shift
 * (ADR 0053), or the ticket in a technician's hands (ADR 0067).
 */
export type SosOrigin =
  | {
      kind: 'post';
      gateId: string | null;
      placeId: string | null;
      shiftId: string;
    }
  | { kind: 'ticket'; ticketId: string };

/**
 * A staff member's SOS (ADR 0053, 0067), shared by the guard's and the
 * technician's: an emergency from where they are, not from a unit, with
 * ADR 0047's flow. Nobody's family is alerted. The caller holds, in
 * SafetyCore's lock order, its own account's lock, a guard's shift FOR
 * SHARE (ADR 0056; a technician has none) and the origin's emergency lock
 * (a post's, or a ticket's), so the one open there — per post and type, or per ticket — is decided one
 * at a time: a repeat answers 200 with it. The other guards on shift and
 * the `emergencies.respond` holders are told at once, the management
 * (`emergencies.manage`) too; with no responder there, the management gets
 * it as an escalation instead. Who raised it never accepts it. A guard may
 * cancel their own (ADR 0053); a technician only asks for it to be called
 * off (ADR 0067): recorded and told, while it stays open until a responder
 * or the management resolves it — someone under duress can be made to
 * cancel.
 */
@Injectable()
export class SosCore {
  constructor(
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly core: SafetyCore,
    private readonly records: EmergencyRecords,
    private readonly escalation: EmergencyEscalation,
  ) {}

  /** The open one at `origin`, or a new one: under the caller's locks. */
  async raiseLocked(
    tx: TenantTxClient,
    origin: SosOrigin,
    type: EmergencyType,
    resource: string,
  ): Promise<{ record: EmergencyRecord; created: boolean }> {
    const me = this.ctx.accountId;
    const where =
      origin.kind === 'post'
        ? origin.gateId
          ? { originGateId: origin.gateId, type }
          : { originPlaceId: origin.placeId!, type }
        : { originTicketId: origin.ticketId };
    const open = await tx.emergency.findFirst({
      where: { ...where, status: { in: OPEN_EMERGENCY } },
    });
    if (open) {
      await this.idempotency.claim(
        tx,
        { type: resource, id: open.id },
        HttpStatus.OK,
      );
      return { record: await this.records.load(tx, open), created: false };
    }
    const id = newId();
    await this.idempotency.claim(tx, { type: resource, id });
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
        ...(origin.kind === 'post'
          ? {
              ...(origin.gateId
                ? { originGateId: origin.gateId }
                : { originPlaceId: origin.placeId! }),
              originShiftId: origin.shiftId,
            }
          : { originTicketId: origin.ticketId }),
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
        gateId: origin.kind === 'post' ? origin.gateId : null,
        placeId: origin.kind === 'post' ? origin.placeId : null,
        shiftId: origin.kind === 'post' ? origin.shiftId : null,
        ...(origin.kind === 'ticket' ? { ticketId: origin.ticketId } : {}),
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
  }

  /**
   * Who raised it asks for it to be called off, while open: recorded once,
   * with a reason code or none, and told — to its responder, or with none
   * yet to everyone who was. It stays open: a responder or the management
   * resolves it (`POST /gate/emergencies/:id/resolve`). Asked again, it is
   * the same request, told once. The caller holds its account's lock and
   * the emergency's (FOR UPDATE).
   */
  async requestCancelLocked(
    tx: TenantTxClient,
    e: Emergency,
    reason: string | null,
  ): Promise<EmergencyRecord> {
    if (!OPEN_EMERGENCY.includes(e.status)) throw emergencyClosed(e.status);
    if (e.cancelRequestedAt) return this.records.load(tx, e);
    const asked = await tx.emergency.update({
      where: { id: e.id },
      data: { cancelRequestedAt: await dbNow(tx), cancelRequestReason: reason },
    });
    await this.audit.record(tx, {
      action: 'emergency.cancel_requested',
      targetId: e.id,
      metadata: { status: e.status, reasonCode: reason },
    });
    const told = e.responderId
      ? [e.responderId]
      : [
          ...(await this.core.guardsOnShift(tx)),
          ...(await this.core.holding(tx, 'emergencies.respond')),
          ...(await this.core.holding(tx, 'emergencies.manage')),
        ];
    await this.core.notify(
      tx,
      told,
      'emergency.cancel_requested',
      e.id,
      {},
      this.ctx.accountId,
    );
    return this.records.load(tx, asked);
  }

  /**
   * Who raised it cancels it while open, with a reason code or none; the
   * caller holds its account's lock and the emergency's (FOR UPDATE). Its
   * responder is told; with none yet, everyone who was.
   */
  async cancelLocked(
    tx: TenantTxClient,
    e: Emergency,
    reason: string | null,
  ): Promise<EmergencyRecord> {
    const me = this.ctx.accountId;
    if (!OPEN_EMERGENCY.includes(e.status)) throw emergencyClosed(e.status);
    const cancelled = await tx.emergency.update({
      where: { id: e.id },
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
      targetId: e.id,
      metadata: { from: e.status, reasonCode: reason },
    });
    const told = e.responderId
      ? [e.responderId]
      : [
          ...(await this.core.guardsOnShift(tx)),
          ...(await this.core.holding(tx, 'emergencies.respond')),
          ...(await this.core.holding(tx, 'emergencies.manage')),
        ];
    await this.core.notify(tx, told, 'emergency.cancelled', e.id, {}, me);
    return this.records.load(tx, cancelled);
  }
}
