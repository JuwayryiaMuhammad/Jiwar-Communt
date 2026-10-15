import { HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Emergency, EmergencyType, Prisma } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { EmergencyEscalation } from './emergency-escalation';
import {
  EMERGENCY_RESOURCE,
  emergencyClosed,
  emergencyNotFound,
  EmergencyRecords,
  OPEN_EMERGENCY,
  type EmergencyRecord,
} from './emergency-records';
import { EmergencyView } from './views/emergency.views';

/** What the household's views add to the record: who is reading. */
export interface HouseholdEmergency extends EmergencyRecord {
  viewer: {
    accountId: string;
    isReporter: boolean;
    isPrimary: boolean;
    /** The viewer's own alert, when they were told. */
    alerted: boolean;
    onMyWayAt: Date | null;
  };
}

const PAGE = keysetCursor('reportedAt', 'desc');

const notAllowed = (message: string) =>
  appError.forbidden(ErrorCode.EMERGENCY_ACTION_NOT_ALLOWED, message);

/**
 * Emergencies, the household's side (ADR 0047). Anyone the unit gives the
 * emergency button (capabilities.emergency) reports one: never rate-limited,
 * one open per unit and type (a repeat answers 200 with the open one).
 * Every guard on an open shift and every `emergencies.respond` holder is
 * told at once (critical); with nobody to tell, the management is, at once.
 * The others who live in the unit get a generic critical push and may answer
 * "on my way". The reporter or the unit's primary may cancel it while open.
 */
@Injectable()
export class EmergenciesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly community: CommunityGatePort,
    private readonly core: SafetyCore,
    private readonly records: EmergencyRecords,
    private readonly escalation: EmergencyEscalation,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(EMERGENCY_RESOURCE, (id) =>
      this.get(id).then((r) => EmergencyView.from(r)),
    );
  }

  /**
   * Reports an emergency, or answers the open one of that type in the unit
   * (`created: false`): decided under the unit's emergency lock, so two
   * reports at once make one.
   */
  report(input: {
    type: EmergencyType;
    unitId: string;
  }): Promise<{ record: HouseholdEmergency; created: boolean }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const caps = await this.community.placeIn(tx, me, input.unitId);
      if (!caps?.emergency)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      await this.core.lockUnit(tx, 'emergency-unit', input.unitId);
      const open = await tx.emergency.findFirst({
        where: {
          unitId: input.unitId,
          type: input.type,
          status: { in: OPEN_EMERGENCY },
        },
      });
      if (open) {
        await this.idempotency.claim(
          tx,
          { type: EMERGENCY_RESOURCE, id: open.id },
          HttpStatus.OK,
        );
        return { record: await this.household(tx, open), created: false };
      }
      const id = newId();
      await this.idempotency.claim(tx, { type: EMERGENCY_RESOURCE, id });
      const responders = [
        ...new Set([
          ...(await this.core.guardsOnShift(tx)),
          ...(await this.core.holding(tx, 'emergencies.respond')),
        ]),
      ].filter((a) => a !== me);
      const family = (await this.community.residents(tx, input.unitId))
        .map((r) => r.accountId)
        .filter((a) => a !== me);
      const tenantId = this.ctx.txTenantId;
      const number = await this.core.nextNumber(tx, 'emergency');
      let emergency = await tx.emergency.create({
        data: {
          id,
          tenantId,
          number,
          unitId: input.unitId,
          type: input.type,
          reportedById: me,
          respondersNotified: responders.length,
        },
      });
      if (family.length)
        await tx.emergencyFamilyAlert.createMany({
          data: family.map((accountId) => ({
            tenantId,
            emergencyId: id,
            accountId,
          })),
        });
      await this.audit.record(tx, {
        action: 'emergency.reported',
        targetId: id,
        metadata: {
          number,
          type: input.type,
          unitId: input.unitId,
          respondersNotified: responders.length,
          familyNotified: family.length,
        },
      });
      await this.core.notify(
        tx,
        responders,
        'emergency.reported',
        id,
        { emergencyType: input.type },
        me,
      );
      await this.core.notify(tx, family, 'emergency.family_alert', id, {}, me);
      if (!responders.length)
        emergency = await this.escalation.escalate(
          tx,
          emergency,
          'no_responders',
        );
      return { record: await this.household(tx, emergency), created: true };
    });
  }

  /** The reporter's, or one they were alerted to; else not found. */
  get(id: string): Promise<HouseholdEmergency> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const e = await tx.emergency.findUnique({ where: { id } });
      if (!e) throw emergencyNotFound();
      const record = await this.household(tx, e);
      if (!record.viewer.isReporter && !record.viewer.alerted)
        throw emergencyNotFound();
      return record;
    });
  }

  /** What the caller reported or was alerted to, newest first. */
  mine(q: {
    status?: 'open' | 'closed';
    cursor?: string;
    limit?: number;
  }): Promise<Page<HouseholdEmergency>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      const alerted = (
        await tx.emergencyFamilyAlert.findMany({
          where: { accountId: me },
          select: { emergencyId: true },
        })
      ).map((a) => a.emergencyId);
      const rows = await tx.emergency.findMany({
        where: {
          AND: [
            { OR: [{ reportedById: me }, { id: { in: alerted } }] },
            ...(q.status === 'open'
              ? [{ status: { in: OPEN_EMERGENCY } }]
              : q.status === 'closed'
                ? [{ status: { notIn: OPEN_EMERGENCY } }]
                : []),
            ...(PAGE.after(q.cursor) as Prisma.EmergencyWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      const out: HouseholdEmergency[] = [];
      for (const e of items) out.push(await this.household(tx, e));
      return { items: out, nextCursor };
    });
  }

  /**
   * The reporter or the unit's primary cancels an open emergency, with a
   * reason code or none. Its responder is told; with none yet, those who
   * would answer it are (and the management when it was escalated).
   */
  cancel(id: string, reasonCode?: string): Promise<HouseholdEmergency> {
    if (
      reasonCode !== undefined &&
      !(REASON_CODES.emergencyCancel as readonly string[]).includes(reasonCode)
    )
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Unknown reason code',
        {
          fields: [
            {
              field: 'reasonCode',
              code: FieldErrorCode.INVALID_REASON_CODE,
              params: { allowed: [...REASON_CODES.emergencyCancel] },
            },
          ],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const e = await this.records.lock(tx, id, 'update');
      const seen = await this.household(tx, e);
      if (!seen.viewer.isReporter && !seen.viewer.alerted)
        throw emergencyNotFound();
      if (!seen.viewer.isReporter && !seen.viewer.isPrimary)
        throw notAllowed(
          'Only the reporter or the unit’s primary cancels an emergency',
        );
      if (!OPEN_EMERGENCY.includes(e.status)) throw emergencyClosed(e.status);
      const cancelled = await tx.emergency.update({
        where: { id },
        data: {
          status: 'cancelled',
          closedAt: await dbNow(tx),
          closedById: me,
          closeSide: 'reporter',
          closeReason: reasonCode ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'emergency.cancelled',
        targetId: id,
        metadata: { from: e.status, reasonCode: reasonCode ?? null },
      });
      const told = e.responderId
        ? [e.responderId]
        : [
            ...(await this.core.guardsOnShift(tx)),
            ...(await this.core.holding(tx, 'emergencies.respond')),
            ...(e.escalatedAt
              ? await this.core.holding(tx, 'emergencies.manage')
              : []),
          ];
      await this.core.notify(tx, told, 'emergency.cancelled', id, {}, me);
      return this.household(tx, cancelled);
    });
  }

  /**
   * One of the others who live in the unit answers "on my way", once, while
   * the emergency is open. A second answer changes nothing.
   */
  onMyWay(id: string): Promise<HouseholdEmergency> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.core.lockSelf(tx);
      const e = await this.records.lock(tx, id, 'share');
      const alert = await tx.emergencyFamilyAlert.findUnique({
        where: {
          tenantId_emergencyId_accountId: {
            tenantId: this.ctx.txTenantId,
            emergencyId: id,
            accountId: me,
          },
        },
      });
      if (!alert) {
        if (e.reportedById === me)
          throw notAllowed('The reporter is there already');
        throw emergencyNotFound();
      }
      if (!OPEN_EMERGENCY.includes(e.status)) throw emergencyClosed(e.status);
      if (!alert.onMyWayAt) {
        await tx.emergencyFamilyAlert.update({
          where: {
            tenantId_emergencyId_accountId: {
              tenantId: this.ctx.txTenantId,
              emergencyId: id,
              accountId: me,
            },
          },
          data: { onMyWayAt: await dbNow(tx) },
        });
        await this.audit.record(tx, {
          action: 'emergency.family_on_my_way',
          targetId: id,
        });
      }
      return this.household(tx, e);
    });
  }

  private async household(
    tx: TenantTxClient,
    e: Emergency,
  ): Promise<HouseholdEmergency> {
    const me = this.ctx.accountId;
    const record = await this.records.load(tx, e);
    const mine = record.alerts.find((a) => a.person.id === me);
    return {
      ...record,
      viewer: {
        accountId: me,
        isReporter: e.reportedById === me,
        isPrimary: await this.community.isPrimary(tx, e.unitId, me),
        alerted: mine !== undefined,
        onMyWayAt: mine?.onMyWayAt ?? null,
      },
    };
  }
}
