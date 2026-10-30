import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmergencyType, GuardAlarmPairing } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { ControlRoom } from '../control-room/control-room';
import { dbNow } from '../db-clock';
import {
  EmergencyRecords,
  OPEN_EMERGENCY,
} from '../emergencies/emergency-records';
import { SosCore } from '../emergencies/sos-core';
import { SafetyCore } from '../safety/safety-core';
import { driverChoice } from '../vendors/vendor-call';
import {
  VendorWebhooks,
  type VendorWebhookAnswer,
} from '../vendors/vendor-webhook';
import {
  ALARM_DRIVER,
  type AlarmDriver,
  type AlarmEvent,
} from './alarm-driver';

/** An alarm's SOS, replayed as the responders' view. */
export const GUARD_ALARM_RESOURCE = 'guard_alarm';
/** A device's clock may drift; an event further off than this is not taken. */
const SKEW_MS = 24 * 3_600_000;

export type AlarmOutcome =
  | 'raised'
  | 'joined'
  | 'cancel_requested'
  | 'cancel_unmatched'
  | 'unpaired'
  | 'replayed'
  | 'stale';

/** A fall or stillness is medical; a panic button is security. */
const TYPE: Record<Exclude<AlarmEvent['kind'], 'cancelled'>, EmergencyType> = {
  panic: 'security',
  fall: 'medical',
  no_motion: 'medical',
};

/**
 * A guard-down alarm (ADR 0068): the vendor's webhook, with the Paymob
 * webhook's rules (VendorWebhooks). Each (device, vendor event) is taken
 * once, under a lock of its own: a replay, or the same event twice at
 * once, is a no-op.
 *
 * A device paired to a guard on an open shift raises that guard's SOS for
 * them, through the staff's SOS core (ADR 0067), from the shift's post: a
 * panic as `security`, a fall or stillness as `medical`. It keeps the
 * core's one open emergency per post and type — a second device at the
 * post joins it — and its telling and escalation. Locks as the guard's own
 * SOS takes them: the guard's account, then the shift, FOR SHARE (ADR
 * 0056), then the device, then the post's emergency lock.
 *
 * Unknown, unpaired, retired, or its shift ended: the control room is told
 * (`guard_alarm_unpaired`); nothing is dropped. The vendor's `cancelled`
 * asks for the device's last open emergency to be called off — recorded and
 * told, while it stays open for a responder to close (someone under duress
 * can be made to cancel).
 */
@Injectable()
export class GuardAlarmsService {
  private readonly off: boolean;

  constructor(
    private readonly webhooks: VendorWebhooks,
    private readonly audit: AuditService,
    private readonly safety: SafetyCore,
    private readonly records: EmergencyRecords,
    private readonly sos: SosCore,
    private readonly controlRoom: ControlRoom,
    @Inject(ALARM_DRIVER) private readonly driver: AlarmDriver,
    config: ConfigService<Env, true>,
  ) {
    this.off = driverChoice(config, 'alarm') === 'off';
  }

  receive(
    compoundId: string,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
    ip: string,
  ): Promise<VendorWebhookAnswer<AlarmOutcome>> {
    return this.webhooks.handle({
      service: 'alarm',
      rejected: 'guard_alarm.webhook_rejected',
      off: this.off,
      compoundId,
      ip,
      verify: () => this.driver.parseEvent(headers, body),
      process: (tx, tenantId, event) => this.process(tx, tenantId, event),
    });
  }

  private async process(
    tx: TenantTxClient,
    tenantId: string,
    event: AlarmEvent,
  ): Promise<AlarmOutcome> {
    // One event at a time, then its row: a replay finds it.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`guard-alarm:${tenantId}:${event.deviceRef}:${event.eventId}`}))`;
    if (
      await tx.guardAlarmEvent.findUnique({
        where: {
          tenantId_deviceRef_vendorEventId: {
            tenantId,
            deviceRef: event.deviceRef,
            vendorEventId: event.eventId,
          },
        },
        select: { id: true },
      })
    )
      return 'replayed';
    const now = await dbNow(tx);
    if (Math.abs(now.getTime() - event.at.getTime()) > SKEW_MS) return 'stale';
    const device = await tx.guardAlarmDevice.findFirst({
      where: { deviceRef: event.deviceRef, retiredAt: null },
    });
    const row = {
      id: newId(),
      tenantId,
      deviceRef: event.deviceRef,
      vendorEventId: event.eventId,
      kind: event.kind,
      occurredAt: event.at,
      deviceId: device?.id ?? null,
    };

    if (event.kind === 'cancelled') {
      const last = await tx.guardAlarmEvent.findFirst({
        where: {
          deviceRef: event.deviceRef,
          emergencyId: { not: null },
          outcome: { in: ['raised', 'joined'] },
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      });
      const e = last?.emergencyId
        ? await this.records.lock(tx, last.emergencyId, 'update')
        : null;
      const open = e && OPEN_EMERGENCY.includes(e.status) ? e : null;
      if (open)
        await this.sos.requestCancelLocked(
          tx,
          open,
          null,
          last!.guardAccountId!,
        );
      await tx.guardAlarmEvent.create({
        data: {
          ...row,
          outcome: open ? 'cancel_requested' : 'cancel_unmatched',
          emergencyId: open?.id ?? null,
          guardAccountId: open ? last!.guardAccountId : null,
        },
      });
      await this.received(
        tx,
        row.id,
        event,
        open ? 'cancel_requested' : 'cancel_unmatched',
        open?.id ?? null,
      );
      return open ? 'cancel_requested' : 'cancel_unmatched';
    }

    const pairing = device
      ? await tx.guardAlarmPairing.findFirst({
          where: { deviceId: device.id, endedAt: null },
        })
      : null;
    const post = pairing ? await this.lockPost(tx, pairing) : null;
    if (!pairing || !post) {
      await tx.guardAlarmEvent.create({
        data: { ...row, outcome: 'unpaired' },
      });
      await this.controlRoom.publish(tx, {
        kind: 'guard_alarm_unpaired',
        source: { type: 'guard_alarm_event', id: row.id },
      });
      await this.received(tx, row.id, event, 'unpaired', null);
      return 'unpaired';
    }
    await this.safety.lockUnit(
      tx,
      'emergency-post',
      post.gateId ?? post.placeId!,
    );
    const { record, created } = await this.sos.raiseLocked(
      tx,
      {
        kind: 'post',
        gateId: post.gateId,
        placeId: post.placeId,
        shiftId: post.id,
      },
      TYPE[event.kind],
      GUARD_ALARM_RESOURCE,
      pairing.guardAccountId,
    );
    const outcome = created ? 'raised' : 'joined';
    const emergencyId = record.emergency.id;
    await tx.guardAlarmEvent.create({
      data: {
        ...row,
        outcome,
        pairingId: pairing.id,
        guardAccountId: pairing.guardAccountId,
        emergencyId,
      },
    });
    await this.controlRoom.publish(tx, {
      kind: 'guard_alarm',
      source: { type: 'guard_alarm_event', id: row.id },
      gateId: post.gateId,
      placeId: post.placeId,
      shiftId: post.id,
    });
    await this.received(tx, row.id, event, outcome, emergencyId);
    return outcome;
  }

  /**
   * The paired guard's account, then the shift, FOR SHARE (ADR 0056), then
   * the device: the pairing still open on a shift still open, or null — a
   * shift's end in flight is waited for, and one that came first unpairs.
   */
  private async lockPost(
    tx: TenantTxClient,
    pairing: GuardAlarmPairing,
  ): Promise<{
    id: string;
    gateId: string | null;
    placeId: string | null;
  } | null> {
    await tx.$queryRaw`
      SELECT id FROM accounts WHERE id = ${pairing.guardAccountId}::uuid FOR SHARE`;
    const [shift] = await tx.$queryRaw<
      { id: string; gateId: string | null; placeId: string | null }[]
    >`
      SELECT id, gate_id AS "gateId", place_id AS "placeId" FROM guard_shifts
       WHERE id = ${pairing.shiftId}::uuid AND ended_at IS NULL FOR SHARE`;
    if (!shift) return null;
    await tx.$queryRaw`
      SELECT id FROM guard_alarm_devices WHERE id = ${pairing.deviceId}::uuid FOR SHARE`;
    const still = await tx.guardAlarmPairing.findUniqueOrThrow({
      where: { id: pairing.id },
    });
    return still.endedAt ? null : shift;
  }

  private async received(
    tx: TenantTxClient,
    id: string,
    event: AlarmEvent,
    outcome: AlarmOutcome,
    emergencyId: string | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'guard_alarm.received',
      targetId: id,
      metadata: { kind: event.kind, outcome, emergencyId },
    });
  }
}
