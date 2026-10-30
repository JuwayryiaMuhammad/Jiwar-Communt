import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ControlRoomEvent } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import {
  boundedCall,
  driverChoice,
  failureKind,
  vendorTimeout,
} from '../vendors/vendor-call';
import {
  CONTROL_ROOM_DRIVER,
  type ControlRoomDriver,
} from './control-room-driver';

export const CONTROL_ROOM_DELIVERY_SWEEP = 'gate.control_room_delivery';
const SWEEP_EVERY_MS = 30_000;
const BATCH = 50;
const backoffMs = (attempts: number) =>
  Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);

/** What the control room is told of (ADR 0068). */
export const CONTROL_ROOM_KINDS = [
  'guard_sos_raised',
  'guard_sos_escalated',
  'guard_alarm',
  'guard_alarm_unpaired',
  'lockdown_started',
  'lockdown_ended',
  'blocklist_match',
  'field_exception_raised',
  'patrol_geofence_exit',
  'device_sync_overdue',
  'gate_call_missed',
] as const;
export type ControlRoomKind = (typeof CONTROL_ROOM_KINDS)[number];

/** What an event points at. */
export type ControlRoomSource =
  | 'emergency'
  | 'guard_alarm_event'
  | 'lockdown'
  | 'blocklist_match'
  | 'gate_field_exception'
  | 'patrol_geofence_exit'
  | 'gate_device'
  | 'gate_call';

/** Alerts: someone may be hurt, or the gate is shut, or a ban is at it. */
const HIGH: readonly ControlRoomKind[] = [
  'guard_sos_raised',
  'guard_sos_escalated',
  'guard_alarm',
  'guard_alarm_unpaired',
  'lockdown_started',
];

export interface ControlRoomInput {
  kind: ControlRoomKind;
  source: { type: ControlRoomSource; id: string };
  gateId?: string | null;
  placeId?: string | null;
  shiftId?: string | null;
  /** High for the kinds that always are; a blocklist match is high for a ban. */
  severity?: 'high' | 'normal';
}

/**
 * The control room's channel (ADR 0068). A source publishes in its own
 * transaction, so an event exists exactly when what caused it committed: a
 * rollback leaves none. The `control_room.watch` holders are told in that
 * transaction — an alert critically — and the actor never is. A sweep then
 * delivers each event to the control-room vendor at least once, keyed by
 * its id, between two transactions on a lease; with the driver off, an
 * event is marked `skipped`. Ids and codes only, never a name.
 */
@Injectable()
export class ControlRoom implements OnModuleInit {
  private readonly logger = new Logger(ControlRoom.name);
  private readonly timeoutMs: number;
  private readonly isOff: boolean;

  constructor(
    private readonly ctx: RequestContext,
    private readonly safety: SafetyCore,
    private readonly sweep: SweepRunner,
    @Inject(CONTROL_ROOM_DRIVER) private readonly driver: ControlRoomDriver,
    config: ConfigService<Env, true>,
  ) {
    this.timeoutMs = vendorTimeout(config);
    this.isOff = driverChoice(config, 'control_room') === 'off';
  }

  onModuleInit(): void {
    this.sweep.register(CONTROL_ROOM_DELIVERY_SWEEP, () => this.deliver(), {
      intervalMs: SWEEP_EVERY_MS,
    });
  }

  /** In the source's transaction: the event, and its watchers told. */
  async publish(
    tx: TenantTxClient,
    input: ControlRoomInput,
  ): Promise<ControlRoomEvent> {
    const severity =
      input.severity ?? (HIGH.includes(input.kind) ? 'high' : 'normal');
    const event = await tx.controlRoomEvent.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        kind: input.kind,
        severity,
        sourceType: input.source.type,
        sourceId: input.source.id,
        gateId: input.gateId ?? null,
        placeId: input.placeId ?? null,
        shiftId: input.shiftId ?? null,
        occurredAt: await dbNow(tx),
      },
    });
    await this.safety.notify(
      tx,
      await this.safety.holding(tx, 'control_room.watch'),
      severity === 'high' ? 'control_room.alert' : 'control_room.event',
      event.id,
      { eventKind: input.kind },
      this.ctx.accountIdOrNull(),
    );
    return event;
  }

  /** The sweep: claim, deliver outside any transaction, record. */
  deliver(): Promise<number> {
    return this.sweep.forEachTenantCall<ControlRoomEvent, void>(
      (tx) => this.claim(tx),
      (tenantId, event) =>
        boundedCall(this.timeoutMs, (signal) =>
          this.driver.deliver(
            {
              tenantId,
              event: {
                eventId: event.id,
                kind: event.kind,
                severity: event.severity as 'high' | 'normal',
                sourceType: event.sourceType,
                sourceId: event.sourceId,
                gateId: event.gateId,
                placeId: event.placeId,
                occurredAt: event.occurredAt,
              },
            },
            signal,
          ),
        ),
      async (tx, _tenantId, event, result) => {
        await tx.$queryRaw`
          SELECT id FROM control_room_events WHERE id = ${event.id}::uuid FOR UPDATE`;
        const now = await dbNow(tx);
        if (result.ok) {
          await tx.controlRoomEvent.update({
            where: { id: event.id },
            data: {
              delivery: 'delivered',
              deliveredAt: now,
              leasedUntil: null,
              lastError: null,
            },
          });
          return 1;
        }
        const kind = failureKind(result.error);
        if (kind === 'unavailable')
          this.logger.warn(
            `control room delivery failed (${result.error instanceof Error ? result.error.name : 'Error'})`,
          );
        const attempts = event.deliveryAttempts + 1;
        await tx.controlRoomEvent.update({
          where: { id: event.id },
          data: {
            leasedUntil: null,
            deliveryAttempts: attempts,
            lastError: kind,
            nextDeliveryAt: new Date(now.getTime() + backoffMs(attempts)),
          },
        });
        return 0;
      },
    );
  }

  private async claim(tx: TenantTxClient): Promise<ControlRoomEvent[]> {
    const now = await dbNow(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM control_room_events
       WHERE delivery = 'pending' AND next_delivery_at <= ${now}
         AND (leased_until IS NULL OR leased_until < ${now})
       ORDER BY next_delivery_at, id LIMIT ${BATCH}
       FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    if (this.isOff) {
      // Nothing to deliver to: skipped, once.
      await tx.controlRoomEvent.updateMany({
        where: { id: { in: ids } },
        data: { delivery: 'skipped' },
      });
      return [];
    }
    await tx.controlRoomEvent.updateMany({
      where: { id: { in: ids } },
      data: {
        leasedUntil: new Date(now.getTime() + 2 * this.timeoutMs + 5_000),
      },
    });
    return tx.controlRoomEvent.findMany({ where: { id: { in: ids } } });
  }
}
