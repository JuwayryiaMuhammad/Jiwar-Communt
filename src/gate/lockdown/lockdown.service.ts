import { HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import { ControlRoom } from '../control-room/control-room';
import type {
  GateLockdown,
  GateLockdownOverride,
  Prisma,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { ShiftsService } from '../shifts/shifts.service';
import { LockdownCore, scopeOf, type LockdownScope } from './lockdown-core';
import {
  GuardLockdownView,
  LockdownOverrideView,
} from './views/lockdown.views';

export const LOCKDOWN_RESOURCE = 'gate_lockdown';
export const LOCKDOWN_OVERRIDE_RESOURCE = 'gate_lockdown_override';

export const END_NOTE = { min: 1, max: 500 } as const;

const PAGE = keysetCursor('startedAt', 'desc');

type Person = { id: string; fullName: string | null; status: string };

/** A lockdown with what its views show, read in one transaction. */
export interface LockdownRecord {
  lockdown: GateLockdown;
  gate: { id: string; name: string } | null;
  startedBy: Person;
  endedBy: Person | null;
  overrides: OverrideRecord[];
}

export interface OverrideRecord {
  override: GateLockdownOverride;
  gate: { id: string; name: string };
  guard: Person;
}

export const lockdownNotFound = () =>
  appError.notFound(ErrorCode.LOCKDOWN_NOT_FOUND, 'Lockdown not found');

const lockdownEnded = () =>
  appError.conflict(ErrorCode.LOCKDOWN_ENDED, 'The lockdown was ended already');

/**
 * The lockdown of the gates (ADR 0053).
 *
 * - **Started** by a guard on shift (at a gate or in a zone), for one gate
 *   or all, with a reason code and the typed confirmation, immediately.
 *   One live lockdown per scope: a second start of a live scope answers 200
 *   with it and tells nobody again. The guards on shift and the management
 *   (`lockdown.end`) get a critical push; every resident a generic critical
 *   one, when this is the first live lockdown.
 * - **While live**, the gate refuses every entry in but a resident's
 *   (LockdownCore). A guard may let an emergency vehicle through a locked
 *   gate, with its code: an override, audited.
 * - **Ended** by the management only, with a reason code and a note of
 *   its own. The same people are told; the residents once none is left.
 *
 * Starts and ends are decided under the compound's lockdown row, FOR
 * UPDATE: two starts make one lockdown, and an end and a start meet in
 * one order.
 */
@Injectable()
export class LockdownService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly community: CommunityGatePort,
    private readonly core: LockdownCore,
    private readonly controlRoom: ControlRoom,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(LOCKDOWN_RESOURCE, async (id) =>
      GuardLockdownView.from(await this.get(id)),
    );
    this.idempotency.renderer(LOCKDOWN_OVERRIDE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const o = await tx.gateLockdownOverride.findUniqueOrThrow({
          where: { id },
        });
        return LockdownOverrideView.from((await this.overrides(tx, [o]))[0]);
      }),
    );
  }

  // --------------------------------------------------------------------------
  // The guard (`gate.operate`, inside a shift)
  // --------------------------------------------------------------------------

  start(input: {
    scope: LockdownScope;
    gateId?: string;
    reasonCode: string;
  }): Promise<{ record: LockdownRecord; created: boolean }> {
    if ((input.scope === 'gate') !== (input.gateId !== undefined))
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A gate for one gate, none for all',
        {
          fields: [
            {
              field: 'gateId',
              code:
                input.scope === 'gate'
                  ? FieldErrorCode.FIELD_REQUIRED
                  : FieldErrorCode.FIELD_NOT_ALLOWED,
            },
          ],
        },
      );
    const reasonCode = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.gateLockdownStart,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      // The account, the shift FOR SHARE, then the lockdown state (ADR
      // 0056's lock order): the shift's end waits for the start, or came
      // first and the guard is refused; never a lockdown started by a
      // shift already over.
      const shift = await this.shifts.requireOnDutyLocked(tx);
      const gateId = input.scope === 'gate' ? input.gateId! : null;
      if (gateId) {
        const gate = await tx.gate.findUnique({ where: { id: gateId } });
        if (gate?.status !== 'active')
          throw appError.notFound(ErrorCode.GATE_NOT_FOUND, 'Gate not found');
      }
      await this.core.lockState(tx, 'update');
      const live = await tx.gateLockdown.findFirst({
        where: { endedAt: null, gateId },
      });
      if (live) {
        await this.idempotency.claim(
          tx,
          { type: LOCKDOWN_RESOURCE, id: live.id },
          HttpStatus.OK,
        );
        return { record: await this.record(tx, live), created: false };
      }
      const othersLive = await tx.gateLockdown.count({
        where: { endedAt: null },
      });
      const id = newId();
      await this.idempotency.claim(tx, { type: LOCKDOWN_RESOURCE, id });
      const lockdown = await tx.gateLockdown.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          gateId,
          reasonCode,
          startedById: me,
          startedShiftId: shift.id,
          startedAt: await dbNow(tx),
        },
      });
      const scope = scopeOf(lockdown);
      const staff = await this.staff(tx);
      const residents = othersLive ? [] : await this.community.everyone(tx);
      const told = await this.safety.notify(
        tx,
        staff,
        'gate_lockdown.started',
        id,
        { scope },
        me,
      );
      const residentsTold = await this.safety.notify(
        tx,
        residents,
        'gate_lockdown.resident_notice',
        id,
        {},
        me,
      );
      await this.audit.record(tx, {
        action: 'gate_lockdown.started',
        targetId: id,
        metadata: {
          scope,
          gateId,
          reasonCode,
          shiftId: shift.id,
          recipients: told,
          residents: residentsTold,
        },
      });
      await this.controlRoom.publish(tx, {
        kind: 'lockdown_started',
        source: { type: 'lockdown', id },
        gateId,
        shiftId: shift.id,
      });
      return { record: await this.record(tx, lockdown), created: true };
    });
  }

  /** The live lockdowns, for a guard on shift: the gate's own and "all". */
  live(): Promise<LockdownRecord[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOnDuty(tx);
      const rows = await tx.gateLockdown.findMany({
        where: { endedAt: null },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      });
      return this.records(tx, rows);
    });
  }

  /**
   * An emergency vehicle let through a locked gate (ADR 0053), by a guard
   * at that gate: the lockdown must hold the gate of their shift. Its code
   * (`gateLockdownOverride`: what kind of vehicle), and the emergency or the
   * lane request it answers, when there is one.
   */
  override(
    lockdownId: string,
    input: {
      reasonCode: string;
      emergencyId?: string;
      gateServiceRequestId?: string;
    },
  ): Promise<OverrideRecord> {
    const kind = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.gateLockdownOverride,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      // The shift FOR SHARE, before the lockdown's state (ADR 0056's lock
      // order): its end waits for the override, or came first and the
      // guard is refused.
      const shift = await this.shifts.requireOpenLocked(tx);
      await this.core.lockState(tx, 'share');
      const lockdown = await tx.gateLockdown.findUnique({
        where: { id: lockdownId },
      });
      if (!lockdown) throw lockdownNotFound();
      if (lockdown.endedAt) throw lockdownEnded();
      if (lockdown.gateId && lockdown.gateId !== shift.gateId)
        throw appError.conflict(
          ErrorCode.LOCKDOWN_NOT_AT_GATE,
          'This lockdown does not hold the gate of your shift',
        );
      if (
        input.emergencyId &&
        !(await tx.emergency.count({ where: { id: input.emergencyId } }))
      )
        throw appError.notFound(
          ErrorCode.EMERGENCY_NOT_FOUND,
          'Emergency not found',
        );
      if (
        input.gateServiceRequestId &&
        !(await tx.gateServiceRequest.count({
          where: { id: input.gateServiceRequestId },
        }))
      )
        throw appError.notFound(
          ErrorCode.GATE_SERVICE_NOT_FOUND,
          'Request not found',
        );
      const id = newId();
      await this.idempotency.claim(tx, {
        type: LOCKDOWN_OVERRIDE_RESOURCE,
        id,
      });
      const override = await tx.gateLockdownOverride.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          lockdownId,
          gateId: shift.gateId,
          shiftId: shift.id,
          guardAccountId: me,
          kind,
          emergencyId: input.emergencyId ?? null,
          gateServiceRequestId: input.gateServiceRequestId ?? null,
          occurredAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'gate_lockdown.override',
        targetId: lockdownId,
        metadata: {
          overrideId: id,
          gateId: shift.gateId,
          shiftId: shift.id,
          kind,
          emergencyId: override.emergencyId,
          gateServiceRequestId: override.gateServiceRequestId,
        },
      });
      return (await this.overrides(tx, [override]))[0];
    });
  }

  // --------------------------------------------------------------------------
  // The management (`lockdown.end`)
  // --------------------------------------------------------------------------

  list(q: {
    status?: 'live' | 'ended';
    cursor?: string;
    limit?: number;
  }): Promise<Page<LockdownRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.gateLockdown.findMany({
        where: {
          AND: [
            ...(q.status === 'live'
              ? [{ endedAt: null }]
              : q.status === 'ended'
                ? [{ endedAt: { not: null } }]
                : []),
            ...(PAGE.after(q.cursor) as Prisma.GateLockdownWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const { items, nextCursor } = PAGE.toPage(rows, limit);
      return { items: await this.records(tx, items), nextCursor };
    });
  }

  get(id: string): Promise<LockdownRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const lockdown = await tx.gateLockdown.findUnique({ where: { id } });
      if (!lockdown) throw lockdownNotFound();
      return this.record(tx, lockdown);
    });
  }

  /**
   * The management ends a live lockdown, with a reason code and a note of
   * its own, under the compound's lockdown row.
   */
  end(
    id: string,
    input: { reasonCode: string; note?: string },
  ): Promise<LockdownRecord> {
    const reasonCode = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.gateLockdownEnd,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const me = this.ctx.accountId;
      await this.safety.lockSelf(tx);
      await this.core.lockState(tx, 'update');
      const lockdown = await tx.gateLockdown.findUnique({ where: { id } });
      if (!lockdown) throw lockdownNotFound();
      if (lockdown.endedAt) throw lockdownEnded();
      const ended = await tx.gateLockdown.update({
        where: { id },
        data: {
          endedAt: await dbNow(tx),
          endedById: me,
          endReason: reasonCode,
          endNote: input.note ?? null,
        },
      });
      const stillLive = await tx.gateLockdown.count({
        where: { endedAt: null },
      });
      const scope = scopeOf(ended);
      const told = await this.safety.notify(
        tx,
        await this.staff(tx),
        'gate_lockdown.ended',
        id,
        { scope },
        me,
      );
      const residentsTold = stillLive
        ? 0
        : await this.safety.notify(
            tx,
            await this.community.everyone(tx),
            'gate_lockdown.ended',
            id,
            { scope },
            me,
          );
      await this.audit.record(tx, {
        action: 'gate_lockdown.ended',
        targetId: id,
        metadata: {
          scope,
          gateId: ended.gateId,
          reasonCode,
          note: input.note !== undefined,
          recipients: told,
          residents: residentsTold,
        },
      });
      await this.controlRoom.publish(tx, {
        kind: 'lockdown_ended',
        source: { type: 'lockdown', id },
        gateId: ended.gateId,
      });
      return this.record(tx, ended);
    });
  }

  /** The guards on shift anywhere, and the management. */
  private async staff(tx: TenantTxClient): Promise<string[]> {
    return [
      ...new Set([
        ...(await this.safety.guardsOnShift(tx)),
        ...(await this.safety.holding(tx, 'lockdown.end')),
      ]),
    ];
  }

  private async record(
    tx: TenantTxClient,
    lockdown: GateLockdown,
  ): Promise<LockdownRecord> {
    return (await this.records(tx, [lockdown]))[0];
  }

  private async records(
    tx: TenantTxClient,
    list: GateLockdown[],
  ): Promise<LockdownRecord[]> {
    if (!list.length) return [];
    const overrides = await this.overrides(
      tx,
      await tx.gateLockdownOverride.findMany({
        where: { lockdownId: { in: list.map((l) => l.id) } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    const gates = await this.gates(
      tx,
      list.flatMap((l) => (l.gateId ? [l.gateId] : [])),
    );
    const people = await this.people(
      tx,
      list.flatMap((l) =>
        l.endedById ? [l.startedById, l.endedById] : [l.startedById],
      ),
    );
    return list.map((l) => ({
      lockdown: l,
      gate: l.gateId ? gates.get(l.gateId)! : null,
      startedBy: people.get(l.startedById)!,
      endedBy: l.endedById ? people.get(l.endedById)! : null,
      overrides: overrides.filter((o) => o.override.lockdownId === l.id),
    }));
  }

  private async overrides(
    tx: TenantTxClient,
    list: GateLockdownOverride[],
  ): Promise<OverrideRecord[]> {
    if (!list.length) return [];
    const gates = await this.gates(
      tx,
      list.map((o) => o.gateId),
    );
    const people = await this.people(
      tx,
      list.map((o) => o.guardAccountId),
    );
    return list.map((o) => ({
      override: o,
      gate: gates.get(o.gateId)!,
      guard: people.get(o.guardAccountId)!,
    }));
  }

  private async gates(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<Map<string, { id: string; name: string }>> {
    if (!ids.length) return new Map();
    const rows = await tx.gate.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((g) => [g.id, g]));
  }

  private async people(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<Map<string, Person>> {
    const rows = await tx.account.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true, status: true },
    });
    return new Map(rows.map((a) => [a.id, a]));
  }
}
