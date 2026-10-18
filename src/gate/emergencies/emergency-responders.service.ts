import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import type { EtaMinutes } from '../safety/safety-rules';
import {
  emergencyClosed,
  EmergencyRecords,
  OPEN_EMERGENCY,
  type EmergencyRecord,
} from './emergency-records';

/** The responders' side reads every emergency of the compound. */
const RESPONDERS = ['emergencies.respond', 'emergencies.manage'] as const;

const QUEUE = keysetCursor('reportedAt', 'asc');
const PAGE = keysetCursor('reportedAt', 'desc');

export const CLOSE_NOTE = { min: 1, max: 500 } as const;

/**
 * Emergencies, the responders' side (ADR 0047). A guard inside an open
 * shift, an `emergencies.respond` holder or an `emergencies.manage` holder
 * sees every emergency of the compound — the unit, the building, the type,
 * the reporter's first name, or the post of a guard's SOS (ADR 0053); never
 * a resident's phone (a resident's number never reaches a staff device).
 * The first to accept it, with the minutes they expect to take, is its
 * responder (409 EMERGENCY_ALREADY_ACCEPTED for the rest); the household
 * is told. The responder marks the arrival; the responder or the
 * management resolves it with a reason code.
 */
@Injectable()
export class EmergencyRespondersService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly core: SafetyCore,
    private readonly records: EmergencyRecords,
  ) {}

  /** `open`: the queue, oldest first; `closed`: newest first. */
  list(q: {
    status?: 'open' | 'closed';
    cursor?: string;
    limit?: number;
  }): Promise<Page<EmergencyRecord>> {
    const limit = clampLimit(q.limit);
    const page = q.status === 'open' ? QUEUE : PAGE;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.acting(tx, RESPONDERS);
      const rows = await tx.emergency.findMany({
        where: {
          AND: [
            ...(q.status === 'open'
              ? [{ status: { in: OPEN_EMERGENCY } }]
              : q.status === 'closed'
                ? [{ status: { notIn: OPEN_EMERGENCY } }]
                : []),
            ...(page.after(q.cursor) as Prisma.EmergencyWhereInput[]),
          ],
        },
        orderBy: page.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = page.toPage(rows, limit);
      return { items: await this.records.loadMany(tx, items), nextCursor };
    });
  }

  get(id: string): Promise<EmergencyRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.acting(tx, RESPONDERS);
      const e = await tx.emergency.findUnique({ where: { id } });
      if (!e)
        throw appError.notFound(
          ErrorCode.EMERGENCY_NOT_FOUND,
          'Emergency not found',
        );
      return this.records.load(tx, e);
    });
  }

  /**
   * The caller becomes its responder, under the emergency's row lock: one
   * wins, the others get 409. The reporter and the family are told.
   */
  accept(id: string, etaMinutes: EtaMinutes): Promise<EmergencyRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const { gateId } = await this.core.acting(tx, RESPONDERS);
      const e = await this.records.lock(tx, id, 'update');
      if (!OPEN_EMERGENCY.includes(e.status)) throw emergencyClosed(e.status);
      // A guard's own SOS (ADR 0053) is someone else's to answer.
      if (e.reportedById === me)
        throw appError.forbidden(
          ErrorCode.EMERGENCY_OWN,
          'Someone else answers the SOS you raised',
        );
      if (e.responderId)
        throw appError.conflict(
          ErrorCode.EMERGENCY_ALREADY_ACCEPTED,
          'Another responder accepted it first',
        );
      const accepted = await tx.emergency.update({
        where: { id },
        data: {
          status: 'on_the_way',
          responderId: me,
          responderGateId: gateId,
          etaMinutes,
          acceptedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'emergency.accepted',
        targetId: id,
        metadata: { etaMinutes, gateId },
      });
      const family = await tx.emergencyFamilyAlert.findMany({
        where: { emergencyId: id },
        select: { accountId: true },
      });
      await this.core.notify(
        tx,
        [e.reportedById, ...family.map((a) => a.accountId)],
        'emergency.responder_on_the_way',
        id,
        { etaMinutes },
        me,
      );
      return this.records.load(tx, accepted);
    });
  }

  /** The responder is there. Again: nothing changes. */
  arrived(id: string): Promise<EmergencyRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      await this.core.acting(tx, RESPONDERS);
      const e = await this.records.lock(tx, id, 'update');
      if (!OPEN_EMERGENCY.includes(e.status)) throw emergencyClosed(e.status);
      if (!e.responderId)
        throw appError.conflict(
          ErrorCode.EMERGENCY_NOT_ON_THE_WAY,
          'Nobody accepted it yet',
          { params: { status: e.status } },
        );
      if (e.responderId !== me)
        throw appError.forbidden(
          ErrorCode.EMERGENCY_NOT_RESPONDER,
          'Only its responder marks the arrival',
        );
      if (e.status === 'arrived') return this.records.load(tx, e);
      const arrived = await tx.emergency.update({
        where: { id },
        data: { status: 'arrived', arrivedAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'emergency.arrived',
        targetId: id,
      });
      return this.records.load(tx, arrived);
    });
  }

  /**
   * Its responder, or an `emergencies.manage` holder (whoever responds or
   * not), closes it with a reason code and, optionally, a note of their own.
   */
  resolve(
    id: string,
    input: { reasonCode?: string; note?: string },
  ): Promise<EmergencyRecord> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.emergencyResolve,
    );
    const note = input.note?.trim() || null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const { permissions } = await this.core.acting(tx, RESPONDERS);
      const e = await this.records.lock(tx, id, 'update');
      if (!OPEN_EMERGENCY.includes(e.status)) throw emergencyClosed(e.status);
      const mine = e.responderId === me;
      if (!mine && !permissions.has('emergencies.manage'))
        throw appError.forbidden(
          ErrorCode.EMERGENCY_NOT_RESPONDER,
          'Only its responder or the management resolves it',
        );
      const resolved = await tx.emergency.update({
        where: { id },
        data: {
          status: 'resolved',
          closedAt: await dbNow(tx),
          closedById: me,
          closeSide: mine ? 'responder' : 'staff',
          closeReason: reason,
          closeNote: note,
        },
      });
      await this.audit.record(tx, {
        action: 'emergency.resolved',
        targetId: id,
        metadata: {
          from: e.status,
          reasonCode: reason,
          side: mine ? 'responder' : 'staff',
          note: note !== null,
        },
      });
      return this.records.load(tx, resolved);
    });
  }
}
