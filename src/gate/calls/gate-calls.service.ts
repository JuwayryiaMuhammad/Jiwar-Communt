import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GateCall } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { ControlRoom } from '../control-room/control-room';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { GateSettingsService } from '../settings/gate-settings.service';
import { ShiftsService } from '../shifts/shifts.service';
import {
  boundedCall,
  callVendor,
  driverChoice,
  vendorTimeout,
  vendorUnavailable,
} from '../vendors/vendor-call';
import {
  VendorWebhooks,
  type VendorWebhookAnswer,
} from '../vendors/vendor-webhook';
import {
  CALL_DRIVER,
  type CallDriver,
  type CallParticipant,
  type CallVendorEvent,
} from './call-driver';

export const GATE_CALL_RESOURCE = 'gate_call';
export const GATE_CALL_TIMEOUT_SWEEP = 'gate.call_timeouts';
export const GATE_CALL_ROOM_SWEEP = 'gate.call_rooms';
const TIMEOUT_EVERY_MS = 15_000;
const ROOMS_EVERY_MS = 60_000;
const BATCH = 100;

const LIVE = ['ringing', 'answered'];

export type EndReason =
  | 'guard'
  | 'resident'
  | 'declined'
  | 'missed'
  | 'max_duration'
  | 'shift_ended'
  | 'vendor'
  | 'unavailable';

export interface GateCallRead {
  call: GateCall;
  unitCode: string;
  gateName: string;
}

export interface CallJoin {
  token: string;
  expiresAt: Date;
}

export const gateCallNotFound = () =>
  appError.notFound(ErrorCode.GATE_CALL_NOT_FOUND, 'Gate call not found');
const ended = (status: string) =>
  appError.conflict(ErrorCode.GATE_CALL_ENDED, 'The call has ended', {
    params: { status },
  });

/** Who joins, opaque to the vendor: the call's own refs, never an account. */
const participant = (
  call: { id: string },
  kind: CallParticipant['kind'],
): CallParticipant => ({ kind, ref: `${call.id}:${kind}` });

/**
 * A masked call from the gate (ADR 0068). A guard on an open shift at a
 * gate calls a unit's household in the app, through the call vendor's
 * rooms: no phone number reaches the vendor or the guard. The household
 * members a gate request goes to (`visitorsInvite`) are rung critically;
 * the first to answer takes it (the call's row lock decides; another is
 * 409 GATE_CALL_ANSWERED), and the guard learns only that the household
 * answered. One live call a guard and a unit.
 *
 * Locks: the account, then the shift (ADR 0056), then the unit's call lock,
 * then the call's row. Vendor calls never inside a transaction: the call is
 * written ringing, its room opened after, recorded in a second; a token is
 * asked for after the answer committed. A call rings for the gate's
 * `callRingSeconds`, then is missed (the control room hears); answered, it
 * lasts at most `callMaxSeconds`. The guard's shift ending ends their live
 * calls. A call that ended has its room closed after, by a sweep if the
 * vendor did not answer then. The vendor's own events about a room come by
 * its webhook (VendorWebhooks), each once: a room it closed ends the call.
 */
@Injectable()
export class GateCallsService implements OnModuleInit {
  private readonly logger = new Logger(GateCallsService.name);
  private readonly timeoutMs: number;
  private readonly off: boolean;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
    private readonly safety: SafetyCore,
    private readonly shifts: ShiftsService,
    private readonly settings: GateSettingsService,
    private readonly community: CommunityGatePort,
    private readonly controlRoom: ControlRoom,
    private readonly webhooks: VendorWebhooks,
    @Inject(CALL_DRIVER) private readonly driver: CallDriver,
    config: ConfigService<Env, true>,
  ) {
    this.timeoutMs = vendorTimeout(config);
    this.off = driverChoice(config, 'call') === 'off';
  }

  onModuleInit(): void {
    this.idempotency.renderer(GATE_CALL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.read(tx, await tx.gateCall.findUniqueOrThrow({ where: { id } })),
      ),
    );
    this.shifts.onEnded(async (tx, shift) => {
      for (const call of await tx.gateCall.findMany({
        where: { shiftId: shift.id, status: { in: LIVE } },
      }))
        await this.finish(tx, call, 'shift_ended');
    });
    this.sweep.register(GATE_CALL_TIMEOUT_SWEEP, (now) => this.timeouts(now), {
      intervalMs: TIMEOUT_EVERY_MS,
    });
    this.sweep.register(GATE_CALL_ROOM_SWEEP, () => this.closeRooms(), {
      intervalMs: ROOMS_EVERY_MS,
    });
  }

  // --------------------------------------------------------------------------
  // The guard
  // --------------------------------------------------------------------------

  async start(input: {
    unitId: string;
    reasonCode: string;
    approvalRequestId?: string;
  }): Promise<GateCallRead> {
    if (this.off) throw vendorUnavailable('call', true);
    const reasonCode = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.gateCallReason,
    );
    const created = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      await this.safety.lockUnit(tx, 'gate-call-unit', input.unitId);
      const unit = await tx.unit.findUnique({
        where: { id: input.unitId },
        select: { id: true },
      });
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (input.approvalRequestId) {
        const request = await tx.gateApprovalRequest.findUnique({
          where: { id: input.approvalRequestId },
          select: { unitId: true },
        });
        if (request?.unitId !== input.unitId)
          throw appError.badRequest(
            ErrorCode.VALIDATION_FAILED,
            'Not a request for this unit',
            {
              fields: [
                {
                  field: 'approvalRequestId',
                  code: FieldErrorCode.INVALID_VALUE,
                },
              ],
            },
          );
      }
      const live = await tx.gateCall.findFirst({
        where: {
          status: { in: LIVE },
          OR: [
            { guardAccountId: this.ctx.accountId },
            { unitId: input.unitId },
          ],
        },
        select: { id: true },
      });
      if (live)
        throw appError.conflict(
          ErrorCode.GATE_CALL_LIVE,
          'A call is live already',
          { params: { callId: live.id } },
        );
      const household = await this.community.holders(
        tx,
        input.unitId,
        'visitorsInvite',
      );
      if (!household.length)
        throw appError.conflict(
          ErrorCode.GATE_CALL_NO_HOUSEHOLD,
          'Nobody in the unit takes gate calls',
        );
      const id = newId();
      await this.idempotency.claim(tx, { type: GATE_CALL_RESOURCE, id });
      const call = await tx.gateCall.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          unitId: input.unitId,
          guardAccountId: this.ctx.accountId,
          shiftId: shift.id,
          gateId: shift.gateId,
          reasonCode,
          approvalRequestId: input.approvalRequestId ?? null,
          startedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'gate_call.started',
        targetId: id,
        metadata: {
          unitId: input.unitId,
          reasonCode,
          shiftId: shift.id,
          rung: household.length,
        },
      });
      await this.safety.notify(
        tx,
        household,
        'gate.call_incoming',
        id,
        { gateName: shift.gateName, reason: reasonCode },
        this.ctx.accountId,
      );
      return call;
    });

    // The room, outside any transaction; a vendor that fails ends the call.
    let roomRef: string;
    try {
      ({ roomRef } = await callVendor('call', this.timeoutMs, (signal) =>
        this.driver.openRoom(
          { tenantId: this.ctx.tenantId, callId: created.id },
          signal,
        ),
      ));
    } catch (e) {
      await this.tenantTx.withTenantTx(async (tx) => {
        const call = await this.lockCall(tx, created.id);
        if (LIVE.includes(call.status))
          await this.finish(tx, call, 'unavailable');
      });
      throw e;
    }
    return this.tenantTx.withTenantTx(async (tx) => {
      const call = await this.lockCall(tx, created.id);
      const set = await tx.gateCall.update({
        where: { id: call.id },
        data: { roomRef },
      });
      return this.read(tx, set);
    });
  }

  /** The guard's own call. */
  guardGet(id: string): Promise<GateCallRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.read(tx, await this.guardsOwn(tx, id)),
    );
  }

  /** A token for the guard's side of their live call's room. */
  async guardJoin(id: string): Promise<CallJoin> {
    const call = await this.tenantTx.withTenantTx((tx) =>
      this.guardsOwn(tx, id),
    );
    return this.join(call, 'guard');
  }

  guardEnd(id: string): Promise<GateCallRead> {
    return this.closeAs(id, 'guard');
  }

  // --------------------------------------------------------------------------
  // The household
  // --------------------------------------------------------------------------

  residentGet(id: string): Promise<GateCallRead> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.read(tx, await this.householdsOwn(tx, id)),
    );
  }

  /**
   * The first answer takes the call; the one who answered may ask again
   * for a token (their app lost it). Another is 409 GATE_CALL_ANSWERED.
   */
  async answer(id: string): Promise<{ read: GateCallRead; join: CallJoin }> {
    const read = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      await this.householdsOwn(tx, id);
      const call = await this.lockCall(tx, id);
      const me = this.ctx.accountId;
      if (call.status === 'answered' && call.answeredByAccountId === me)
        return this.read(tx, call);
      if (call.status === 'answered')
        throw appError.conflict(
          ErrorCode.GATE_CALL_ANSWERED,
          'Someone else answered',
        );
      if (call.status !== 'ringing') throw ended(call.status);
      const answered = await tx.gateCall.update({
        where: { id },
        data: {
          status: 'answered',
          answeredAt: await dbNow(tx),
          answeredByAccountId: me,
        },
      });
      await this.audit.record(tx, {
        action: 'gate_call.answered',
        targetId: id,
        metadata: { unitId: call.unitId },
      });
      return this.read(tx, answered);
    });
    return { read, join: await this.join(read.call, 'household') };
  }

  /** A household member declines a ringing call: it ends for everyone. */
  decline(id: string): Promise<GateCallRead> {
    return this.closeAs(id, 'declined');
  }

  /** The one who answered ends it. */
  residentEnd(id: string): Promise<GateCallRead> {
    return this.closeAs(id, 'resident');
  }

  // --------------------------------------------------------------------------
  // The vendor's webhook
  // --------------------------------------------------------------------------

  receive(
    compoundId: string,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
    ip: string,
  ): Promise<VendorWebhookAnswer<'recorded' | 'ended' | 'replayed'>> {
    return this.webhooks.handle({
      service: 'call',
      rejected: 'gate_call.webhook_rejected',
      off: this.off,
      compoundId,
      ip,
      verify: () => this.driver.parseEvent(headers, body),
      process: (tx, tenantId, event) => this.vendorEvent(tx, tenantId, event),
    });
  }

  private async vendorEvent(
    tx: TenantTxClient,
    tenantId: string,
    event: CallVendorEvent,
  ): Promise<'recorded' | 'ended' | 'replayed'> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`gate-call-event:${tenantId}:${event.eventId}`}))`;
    if (
      await tx.gateCallVendorEvent.findUnique({
        where: {
          tenantId_vendorEventId: { tenantId, vendorEventId: event.eventId },
        },
        select: { id: true },
      })
    )
      return 'replayed';
    const found = await tx.gateCall.findFirst({
      where: { roomRef: event.roomRef },
      select: { id: true },
    });
    const call = found ? await this.lockCall(tx, found.id) : null;
    await tx.gateCallVendorEvent.create({
      data: {
        id: newId(),
        tenantId,
        callId: call?.id ?? null,
        roomRef: event.roomRef,
        vendorEventId: event.eventId,
        kind: event.kind,
        occurredAt: event.at,
      },
    });
    if (event.kind !== 'room_closed' || !call) return 'recorded';
    const now = await dbNow(tx);
    if (LIVE.includes(call.status)) await this.finish(tx, call, 'vendor', now);
    const after = await tx.gateCall.findUniqueOrThrow({
      where: { id: call.id },
    });
    if (!after.roomClosedAt)
      await tx.gateCall.update({
        where: { id: call.id },
        data: { roomClosedAt: now },
      });
    return 'ended';
  }

  // --------------------------------------------------------------------------
  // The sweeps
  // --------------------------------------------------------------------------

  /** Ringing too long: missed; answered too long: ended. */
  timeouts(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const { callRingSeconds, callMaxSeconds } = await this.settings.read(tx);
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM gate_calls
         WHERE (status = 'ringing'
                AND started_at <= ${new Date(now.getTime() - callRingSeconds * 1000)})
            OR (status = 'answered'
                AND answered_at <= ${new Date(now.getTime() - callMaxSeconds * 1000)})
         ORDER BY started_at, id LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`;
      let done = 0;
      for (const { id } of due) {
        const call = await tx.gateCall.findUniqueOrThrow({ where: { id } });
        if (!LIVE.includes(call.status)) continue;
        await this.finish(
          tx,
          call,
          call.status === 'ringing' ? 'missed' : 'max_duration',
        );
        done++;
      }
      return done;
    });
  }

  /** The rooms of calls that ended, closed at the vendor (again, if it failed). */
  closeRooms(): Promise<number> {
    return this.sweep.forEachTenantCall<{ id: string; roomRef: string }, void>(
      async (tx) =>
        tx.$queryRaw<{ id: string; roomRef: string }[]>`
          SELECT id, room_ref AS "roomRef" FROM gate_calls
           WHERE ended_at IS NOT NULL AND room_ref IS NOT NULL
             AND room_closed_at IS NULL
           ORDER BY ended_at, id LIMIT ${BATCH}
           FOR UPDATE SKIP LOCKED`,
      (tenantId, one) =>
        boundedCall(this.timeoutMs, (signal) =>
          this.driver.closeRoom({ tenantId, roomRef: one.roomRef }, signal),
        ),
      async (tx, _tenantId, one, result) => {
        if (!result.ok) return 0;
        await tx.gateCall.updateMany({
          where: { id: one.id, roomClosedAt: null },
          data: { roomClosedAt: await dbNow(tx) },
        });
        return 1;
      },
    );
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async closeAs(
    id: string,
    reason: 'guard' | 'resident' | 'declined',
  ): Promise<GateCallRead> {
    const read = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      if (reason === 'guard') await this.guardsOwn(tx, id);
      else await this.householdsOwn(tx, id);
      const call = await this.lockCall(tx, id);
      if (!LIVE.includes(call.status)) throw ended(call.status);
      if (reason === 'declined' && call.status !== 'ringing')
        throw appError.conflict(
          ErrorCode.GATE_CALL_ANSWERED,
          'Someone answered already',
        );
      if (
        reason === 'resident' &&
        call.answeredByAccountId !== this.ctx.accountId
      )
        throw gateCallNotFound();
      return this.read(tx, await this.finish(tx, call, reason));
    });
    await this.closeRoomNow(read.call);
    return read;
  }

  /** In the caller's transaction, holding the call's row: it ends, once. */
  private async finish(
    tx: TenantTxClient,
    call: GateCall,
    reason: EndReason,
    at?: Date,
  ): Promise<GateCall> {
    const status =
      reason === 'missed'
        ? 'missed'
        : reason === 'declined'
          ? 'declined'
          : 'ended';
    const done = await tx.gateCall.update({
      where: { id: call.id },
      data: { status, endedAt: at ?? (await dbNow(tx)), endReason: reason },
    });
    await this.audit.record(tx, {
      action: reason === 'missed' ? 'gate_call.missed' : 'gate_call.ended',
      targetId: call.id,
      metadata: {
        unitId: call.unitId,
        reason,
        answered: call.answeredAt !== null,
      },
    });
    if (reason === 'missed')
      await this.controlRoom.publish(tx, {
        kind: 'gate_call_missed',
        source: { type: 'gate_call', id: call.id },
        gateId: call.gateId,
        shiftId: call.shiftId,
      });
    return done;
  }

  /** Best effort, after the commit: a failure leaves it to the sweep. */
  private async closeRoomNow(call: GateCall): Promise<void> {
    if (!call.roomRef) return;
    try {
      await boundedCall(this.timeoutMs, (signal) =>
        this.driver.closeRoom(
          { tenantId: this.ctx.tenantId, roomRef: call.roomRef! },
          signal,
        ),
      );
      await this.tenantTx.withTenantTx(async (tx) =>
        tx.gateCall.updateMany({
          where: { id: call.id, roomClosedAt: null },
          data: { roomClosedAt: await dbNow(tx) },
        }),
      );
    } catch (e) {
      this.logger.warn(
        `a call's room was left to the sweep (${e instanceof Error ? e.name : 'Error'})`,
      );
    }
  }

  private async join(
    call: GateCall,
    kind: CallParticipant['kind'],
  ): Promise<CallJoin> {
    if (!LIVE.includes(call.status)) throw ended(call.status);
    if (!call.roomRef)
      throw appError.conflict(
        ErrorCode.GATE_CALL_NOT_READY,
        'The call’s room is not open yet',
      );
    return callVendor('call', this.timeoutMs, (signal) =>
      this.driver.joinToken(
        {
          tenantId: this.ctx.tenantId,
          roomRef: call.roomRef!,
          participant: participant(call, kind),
        },
        signal,
      ),
    );
  }

  private async guardsOwn(tx: TenantTxClient, id: string): Promise<GateCall> {
    const call = await tx.gateCall.findUnique({ where: { id } });
    if (!call || call.guardAccountId !== this.ctx.accountId)
      throw gateCallNotFound();
    return call;
  }

  /** A call rung to the caller's household: whoever takes gate calls there now. */
  private async householdsOwn(
    tx: TenantTxClient,
    id: string,
  ): Promise<GateCall> {
    const call = await tx.gateCall.findUnique({ where: { id } });
    if (
      !call ||
      !(
        await this.community.holders(tx, call.unitId, 'visitorsInvite')
      ).includes(this.ctx.accountId)
    )
      throw gateCallNotFound();
    return call;
  }

  private async lockCall(tx: TenantTxClient, id: string): Promise<GateCall> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM gate_calls WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw gateCallNotFound();
    return tx.gateCall.findUniqueOrThrow({ where: { id } });
  }

  private async read(
    tx: TenantTxClient,
    call: GateCall,
  ): Promise<GateCallRead> {
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: call.unitId },
      select: { code: true },
    });
    const gate = await tx.gate.findUniqueOrThrow({
      where: { id: call.gateId },
      select: { name: true },
    });
    return { call, unitCode: unit.code, gateName: gate.name };
  }
}
