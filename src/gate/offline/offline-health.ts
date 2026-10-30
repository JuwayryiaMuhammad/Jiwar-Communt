import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ControlRoom } from '../control-room/control-room';
import type { GateDevice } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { SafetyCore } from '../safety/safety-core';
import { GateSettingsService } from '../settings/gate-settings.service';
import {
  deviceRevoked,
  DeviceEnvelopes,
  type DeviceEnvelope,
} from './device-envelopes';
import { OfflineFlags } from './offline-flags.service';
import { missingActions } from './offline-sequence';

const MINUTE = 60_000;
export const OFFLINE_SYNC_HEALTH_SWEEP = 'gate.offline_sync_health';
/** A bundle older than this is refreshed while the device is online. */
export const BUNDLE_REFRESH_MS = 15 * MINUTE;
/** Flags untold this long after they were raised are told by the sweep. */
export const UNTOLD_GRACE_MS = MINUTE;

export interface HeartbeatResult {
  serverTime: Date;
  ackedThroughSeq: number;
  /** Download a new bundle: it is old, or a lockdown or the blocklist changed since. */
  refreshBundle: boolean;
}

/**
 * The devices' sync health (ADR 0057).
 *
 * - **Every call a device makes says it is alive** (`last_seen_at`): its
 *   enrolment, a bundle, an upload (also `last_upload_at`), a heartbeat.
 * - **A heartbeat** (`POST /gate/offline/heartbeat`, signed) says how many
 *   actions it still holds, and learns what the server acknowledged and
 *   whether to refresh its bundle: older than 15 minutes, or a lockdown
 *   started or ended, or the blocklist changed, since it was issued.
 * - **The sweep `gate.offline_sync_health`** (every minute) tells the
 *   `gate_devices.manage` holders, once per outage, of a device not seen
 *   for `offlineSyncAlertMinutes` while its last bundle's shift is open
 *   and the bundle valid (`gate_device.sync_overdue`); once per gap, of a
 *   sequence still missing actions that long after its last upload
 *   (`gate_device.sequence_gap`); and tells the flags an upload left
 *   untold (a crash between its actions and its alert). Each device is
 *   taken FOR UPDATE SKIP LOCKED: a device in a call holds it.
 */
@Injectable()
export class OfflineHealth implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly safety: SafetyCore,
    private readonly envelopes: DeviceEnvelopes,
    private readonly settings: GateSettingsService,
    private readonly flags: OfflineFlags,
    private readonly sweep: SweepRunner,
    private readonly controlRoom: ControlRoom,
  ) {}

  onModuleInit(): void {
    this.sweep.register(
      OFFLINE_SYNC_HEALTH_SWEEP,
      (now) => this.sweep.forEachTenant((tx) => this.check(tx, now)),
      { intervalMs: MINUTE },
    );
  }

  heartbeat(envelope: DeviceEnvelope): Promise<HeartbeatResult> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const { device, payload, now } = await this.envelopes.open(
        tx,
        envelope,
        'heartbeat',
      );
      if (device.revokedAt) throw deviceRevoked();
      const pending = payload.pendingCount;
      if (
        typeof pending !== 'number' ||
        !Number.isSafeInteger(pending) ||
        pending < 0
      )
        throw appError.unprocessable(
          ErrorCode.GATE_DEVICE_ENVELOPE_INVALID,
          'A heartbeat says how many actions the device holds',
          { params: { reason: 'payload' } },
        );
      await tx.gateDevice.update({
        where: { id: device.id },
        data: { lastSeenAt: now, pendingCount: pending },
      });
      return {
        serverTime: now,
        ackedThroughSeq: device.ackedSeq,
        refreshBundle: await this.stale(tx, device, now),
      };
    });
  }

  /** Whether the device's bundle should be downloaded again. */
  private async stale(
    tx: TenantTxClient,
    d: GateDevice,
    now: Date,
  ): Promise<boolean> {
    const since = d.lastBundleAt;
    if (!since || now.getTime() - since.getTime() > BUNDLE_REFRESH_MS)
      return true;
    const lockdowns = await tx.gateLockdown.count({
      where: { OR: [{ startedAt: { gt: since } }, { endedAt: { gt: since } }] },
    });
    if (lockdowns) return true;
    return (
      (await tx.blocklistEntry.count({ where: { updatedAt: { gt: since } } })) >
      0
    );
  }

  /** One compound's run of the sweep: how many alerts it sent. */
  private async check(tx: TenantTxClient, now: Date): Promise<number> {
    const { offlineSyncAlertMinutes } = await this.settings.read(tx, 'share');
    const cutoff = new Date(now.getTime() - offlineSyncAlertMinutes * MINUTE);
    const keepers = () => this.safety.holding(tx, 'gate_devices.manage');
    let told = 0;
    // Not seen, while on shift with a live bundle: once per outage.
    const quiet = await tx.gateDevice.findMany({
      where: {
        revokedAt: null,
        lastSeenAt: { lt: cutoff },
        bundleVersion: { gt: 0 },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const { id } of quiet) {
      const d = await this.lockFree(tx, id);
      if (
        !d?.lastSeenAt ||
        d.lastSeenAt >= cutoff ||
        (d.overdueAlertedAt && d.overdueAlertedAt >= d.lastSeenAt)
      )
        continue;
      const bundle = await tx.gateOfflineBundle.findFirst({
        where: { deviceId: d.id, version: d.bundleVersion },
        select: { shiftId: true, gateId: true, validUntil: true },
      });
      if (!bundle || bundle.validUntil <= now) continue;
      const shift = await tx.guardShift.findUnique({
        where: { id: bundle.shiftId },
        select: { endedAt: true },
      });
      if (!shift || shift.endedAt) continue;
      await this.safety.notify(
        tx,
        await keepers(),
        'gate_device.sync_overdue',
        d.id,
        { minutes: offlineSyncAlertMinutes },
      );
      await tx.gateDevice.update({
        where: { id: d.id },
        data: { overdueAlertedAt: now },
      });
      await this.controlRoom.publish(tx, {
        kind: 'device_sync_overdue',
        source: { type: 'gate_device', id: d.id },
        gateId: bundle.gateId,
        shiftId: bundle.shiftId,
      });
      told++;
    }
    // A sequence missing actions since its last upload: once per gap.
    const gapped = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM gate_devices
       WHERE max_seq > acked_seq AND last_upload_at < ${cutoff}
         AND (gap_alerted_at IS NULL OR gap_alerted_at < last_upload_at)
       ORDER BY id`;
    for (const { id } of gapped) {
      const d = await this.lockFree(tx, id);
      if (
        !d?.lastUploadAt ||
        d.maxSeq <= d.ackedSeq ||
        d.lastUploadAt >= cutoff ||
        (d.gapAlertedAt && d.gapAlertedAt >= d.lastUploadAt)
      )
        continue;
      await this.safety.notify(
        tx,
        await keepers(),
        'gate_device.sequence_gap',
        d.id,
        { missing: await missingActions(tx, d) },
      );
      await tx.gateDevice.update({
        where: { id: d.id },
        data: { gapAlertedAt: now },
      });
      told++;
    }
    // What an upload raised and never told.
    const untold = await tx.gateOfflineFlag.findMany({
      where: {
        alertedAt: null,
        class: { not: 'info' },
        createdAt: { lt: new Date(now.getTime() - UNTOLD_GRACE_MS) },
      },
      select: { batchId: true },
      distinct: ['batchId'],
    });
    for (const { batchId } of untold)
      if (await this.flags.alertBatch(tx, batchId)) told++;
    return told;
  }

  /** The device under its lock, or null when a call of its holds it. */
  private async lockFree(
    tx: TenantTxClient,
    id: string,
  ): Promise<GateDevice | null> {
    const held = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM gate_devices WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
    if (!held.length) return null;
    return tx.gateDevice.findUnique({ where: { id } });
  }
}
