import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { GateDevice, GateOfflineAction } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  AppException,
  appError,
  ErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { LockdownCore } from '../lockdown/lockdown-core';
import { SafetyCore } from '../safety/safety-core';
import {
  deviceRevoked,
  DeviceEnvelopes,
  type DeviceEnvelope,
  type OpenedEnvelope,
} from './device-envelopes';
import { GateDevicesService } from './gate-devices.service';
import { OfflineEntries } from './offline-entries';
import { OfflineFlags, type NewFlag } from './offline-flags.service';
import {
  parseUpload,
  SKEW_MS,
  whenOf,
  type FlagKind,
  type OfflineAction,
  type Rejection,
} from './offline-rules';

/** How often a device's refused uploads are told, at most. */
export const REJECTION_ALERT_MS = 15 * 60_000;

export type ActionStatus = 'recorded' | 'duplicate' | 'rejected';

export interface ActionResult {
  clientId: string;
  seq: number;
  status: ActionStatus;
  /** Why it was rejected: its code. */
  reason: string | null;
  flags: FlagKind[];
  /** The entry it recorded. */
  entryId: string | null;
}

export interface UploadResult {
  batchId: string;
  receivedAt: Date;
  /** Every action up to this one was received, without a gap. */
  ackedThroughSeq: number;
  results: ActionResult[];
  serverTime: Date;
}

/** Why an upload was refused whole, as the audit and the alert say it. */
export type UploadRefusal = 'signature' | 'envelope' | 'payload';

/**
 * Offline uploads (ADR 0057): what a guard device recorded without
 * network, in signed batches, recorded at sync without loss.
 *
 * 1. The envelope (DeviceEnvelopes): the device's signature over the
 *    payload as sent. A signature that does not verify, an envelope that
 *    says something else, a payload that does not parse: the whole batch
 *    is refused, audited, and the management told (once per device in 15
 *    minutes); nothing else is written.
 * 2. The batch, once per id: a retry answers what its actions recorded.
 * 3. Each action in its own transaction, in sequence: a duplicate id with
 *    the same content answers what it recorded; one whose id or sequence
 *    number another action holds is flagged and not recorded; one whose
 *    bundle or subject this compound does not know cannot have happened
 *    and is rejected, flagged; everything else is recorded at its device
 *    time (clamped, offline-rules.ts `whenOf`), with its flags.
 * 4. The batch's flags told, once (OfflineFlags.alertBatch).
 *
 * The uploader is any active guard: what an action records is attributed
 * to its bundle's guard, shift and gate.
 *
 * Lock order per action: the uploader's account (FOR SHARE), the bundle's
 * shift (FOR SHARE, ended or not), the device (FOR UPDATE), the lockdown
 * row (FOR SHARE), the blocklist (shared), the subject's row.
 */
@Injectable()
export class OfflineUploadsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly safety: SafetyCore,
    private readonly audit: AuditService,
    private readonly envelopes: DeviceEnvelopes,
    private readonly devices: GateDevicesService,
    private readonly lockdown: LockdownCore,
    private readonly settings: TenantSettingsService,
    private readonly entries: OfflineEntries,
    private readonly flags: OfflineFlags,
  ) {}

  async upload(envelope: DeviceEnvelope): Promise<UploadResult> {
    const opened = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      let o: OpenedEnvelope;
      try {
        o = await this.envelopes.open(tx, envelope, 'upload');
      } catch (e) {
        const why = refusalOf(e);
        if (why) return { refused: why, error: e as AppException };
        throw e;
      }
      if (o.device.revokedAt) throw deviceRevoked();
      const parsed = parseUpload(o.payload);
      if ('problems' in parsed)
        return {
          refused: 'payload' as const,
          error: appError.badRequest(
            ErrorCode.VALIDATION_FAILED,
            'The upload’s payload does not parse',
            {
              fields: parsed.problems.map((p): FieldError => ({
                field: `payload.${p.field}`,
                code: p.code,
              })),
            },
          ),
        };
      const payloadSha256 = createHash('sha256')
        .update(envelope.payload)
        .digest('hex');
      await tx.$executeRaw`
        INSERT INTO gate_offline_batches
          (id, tenant_id, device_id, uploaded_by_account_id, received_at, sent_at,
           clock_offset_ms, payload_sha256, action_count, status)
        VALUES (${parsed.batchId}::uuid, ${this.ctx.txTenantId}::uuid, ${o.device.id}::uuid,
                ${this.ctx.accountId}::uuid, ${o.now}, ${o.sentAt},
                ${Math.round(o.sentAt.getTime() - o.now.getTime())},
                ${payloadSha256}, ${parsed.actions.length}, 'accepted')
        ON CONFLICT DO NOTHING`;
      const batch = await tx.gateOfflineBatch.findUnique({
        where: { id: parsed.batchId },
      });
      // A batch id this device did not use: another device's.
      if (!batch || batch.deviceId !== o.device.id)
        return {
          refused: 'payload' as const,
          error: appError.badRequest(
            ErrorCode.VALIDATION_FAILED,
            'This batch id is taken',
            {
              fields: [{ field: 'payload.batchId', code: 'INVALID_VALUE' }],
            },
          ),
        };
      // Told once per batch: a device whose clock drifted from its
      // calibration (ADR 0057's two minutes).
      if (
        batch.receivedAt.getTime() === o.now.getTime() &&
        Math.abs(batch.clockOffsetMs) > SKEW_MS
      )
        await this.flags.raise(tx, [
          {
            kind: 'clock_skew',
            batchId: batch.id,
            deviceId: o.device.id,
            params: { offsetSeconds: Math.round(batch.clockOffsetMs / 1000) },
          },
        ]);
      return {
        device: o.device,
        batchId: batch.id,
        receivedAt: batch.receivedAt,
        actions: parsed.actions,
      };
    });
    if (opened.refused) {
      await this.refused(envelope.deviceId, opened.refused);
      throw opened.error;
    }
    const results: ActionResult[] = [];
    for (const a of opened.actions)
      results.push(await this.one(opened.device.id, opened.batchId, a));
    const acked = await this.tenantTx.withTenantTx(async (tx) => {
      await this.flags.alertBatch(tx, opened.batchId);
      return {
        device: await this.devices.row(tx, opened.device.id),
        now: await dbNow(tx),
      };
    });
    return {
      batchId: opened.batchId,
      receivedAt: opened.receivedAt,
      ackedThroughSeq: acked.device.ackedSeq,
      results,
      serverTime: acked.now,
    };
  }

  // --------------------------------------------------------------------------

  /** One action, in a transaction of its own. */
  private one(
    deviceId: string,
    batchId: string,
    a: OfflineAction,
  ): Promise<ActionResult> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const bundle = await tx.gateOfflineBundle.findUnique({
        where: { id: a.bundleId },
      });
      const own = bundle && bundle.deviceId === deviceId ? bundle : null;
      const shift = own
        ? (
            await tx.$queryRaw<{ ended_at: Date | null }[]>`
              SELECT ended_at FROM guard_shifts
               WHERE id = ${own.shiftId}::uuid FOR SHARE`
          )[0]
        : null;
      await this.devices.lock(tx, deviceId);
      const device = await this.devices.row(tx, deviceId);
      const existing = await tx.gateOfflineAction.findUnique({
        where: { id: a.clientId },
      });
      if (existing) {
        if (
          existing.deviceId === deviceId &&
          existing.seq === a.seq &&
          existing.contentSha256 === a.contentSha256
        )
          return this.answer(tx, existing, 'duplicate');
        return this.collision(tx, device, batchId, a, 'client_id_reused');
      }
      if (
        await tx.gateOfflineAction.count({
          where: { deviceId, seq: a.seq },
        })
      )
        return this.collision(tx, device, batchId, a, 'sequence_reused');
      const receivedAt = await dbNow(tx);
      const base = {
        id: a.clientId,
        tenantId: this.ctx.txTenantId,
        deviceId,
        batchId,
        seq: a.seq,
        type: a.type,
        contentSha256: a.contentSha256,
        deviceTime: a.deviceTime,
        receivedAt,
      };
      if (!own) return this.rejected(tx, device, base, null, 'bundle_unknown');
      const previous = await tx.gateOfflineAction.findUnique({
        where: {
          tenantId_deviceId_seq: {
            tenantId: this.ctx.txTenantId,
            deviceId,
            seq: a.seq - 1,
          },
        },
        select: { deviceTime: true },
      });
      const when = whenOf({
        deviceTime: a.deviceTime,
        previousDeviceTime: previous?.deviceTime ?? null,
        bundle: own,
        receivedAt,
        shiftEndedAt: shift?.ended_at ?? null,
      });
      await this.lockdown.lockState(tx, 'share');
      const gate = await tx.gate.findUniqueOrThrow({
        where: { id: own.gateId },
        select: { name: true },
      });
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const outcome = await this.entries.record(tx, {
        action: a,
        occurredAt: when.occurredAt,
        gateId: own.gateId,
        gateName: gate.name,
        shiftId: own.shiftId,
        guardId: own.guardAccountId,
        timezone,
      });
      if ('rejection' in outcome)
        return this.rejected(tx, device, base, own.id, outcome.rejection);
      const row = await tx.gateOfflineAction.create({
        data: {
          ...base,
          bundleId: own.id,
          occurredAt: when.occurredAt,
          status: 'recorded',
          guardAccountId: own.guardAccountId,
          shiftId: own.shiftId,
          gateId: own.gateId,
          entryId: outcome.entryId,
        },
      });
      const where = { gateId: own.gateId, shiftId: own.shiftId };
      await this.flags.raise(tx, [
        ...when.flags.map((kind): NewFlag => ({
          kind,
          batchId,
          deviceId,
          actionId: row.id,
          ...where,
          params:
            kind === 'clock_skew' && when.skewMs !== null
              ? { skewSeconds: Math.round(when.skewMs / 1000) }
              : {},
        })),
        ...outcome.flags.map((f): NewFlag => ({
          ...f,
          batchId,
          deviceId,
          actionId: row.id,
        })),
      ]);
      if (a.direction === 'in')
        await this.flags.reconcile(
          tx,
          { type: a.subjectType, id: a.subjectId },
          when.occurredAt,
        );
      await this.acknowledge(tx, device, a.seq);
      return this.answer(tx, row, 'recorded');
    });
  }

  /** Cannot have happened as said: rejected, kept and flagged. */
  private async rejected(
    tx: TenantTxClient,
    device: GateDevice,
    base: Omit<
      GateOfflineAction,
      | 'bundleId'
      | 'occurredAt'
      | 'status'
      | 'rejectReason'
      | 'guardAccountId'
      | 'shiftId'
      | 'gateId'
      | 'entryId'
    >,
    bundleId: string | null,
    reason: Rejection,
  ): Promise<ActionResult> {
    const row = await tx.gateOfflineAction.create({
      data: { ...base, bundleId, status: 'rejected', rejectReason: reason },
    });
    await this.flags.raise(tx, [
      {
        kind: 'action_rejected',
        batchId: base.batchId,
        deviceId: device.id,
        actionId: row.id,
        params: { reason },
      },
    ]);
    await this.acknowledge(tx, device, base.seq);
    return this.answer(tx, row, 'rejected');
  }

  /**
   * An action whose id or sequence number another one holds: not recorded
   * (the other one is), flagged on the batch.
   */
  private async collision(
    tx: TenantTxClient,
    device: GateDevice,
    batchId: string,
    a: OfflineAction,
    reason: 'client_id_reused' | 'sequence_reused',
  ): Promise<ActionResult> {
    await this.flags.raise(tx, [
      {
        kind: 'action_rejected',
        batchId,
        deviceId: device.id,
        params: { reason, seq: a.seq },
      },
    ]);
    return {
      clientId: a.clientId,
      seq: a.seq,
      status: 'rejected',
      reason,
      flags: ['action_rejected'],
      entryId: null,
    };
  }

  /**
   * The device's sequence: the highest received, and the last received
   * without a gap, walked forward over what arrived out of order.
   */
  private async acknowledge(
    tx: TenantTxClient,
    device: GateDevice,
    seq: number,
  ): Promise<void> {
    let acked = device.ackedSeq;
    if (seq === acked + 1) {
      acked = seq;
      const after = await tx.gateOfflineAction.findMany({
        where: { deviceId: device.id, seq: { gt: acked } },
        select: { seq: true },
        orderBy: { seq: 'asc' },
      });
      for (const n of after) {
        if (n.seq !== acked + 1) break;
        acked = n.seq;
      }
    }
    await tx.gateDevice.update({
      where: { id: device.id },
      data: { ackedSeq: acked, maxSeq: Math.max(device.maxSeq, seq) },
    });
  }

  private async answer(
    tx: TenantTxClient,
    row: GateOfflineAction,
    status: ActionStatus,
  ): Promise<ActionResult> {
    const flags = await tx.gateOfflineFlag.findMany({
      where: { actionId: row.id },
      select: { kind: true },
      orderBy: { kind: 'asc' },
    });
    return {
      clientId: row.id,
      seq: row.seq,
      status:
        status === 'duplicate' || row.status === 'recorded'
          ? status
          : 'rejected',
      reason: row.rejectReason,
      flags: flags.map((f) => f.kind as FlagKind),
      entryId: row.entryId,
    };
  }

  /**
   * A whole upload refused: audited, and the management told, once per
   * device in REJECTION_ALERT_MS. Its own transaction, which commits
   * before the refusal goes out.
   */
  private async refused(deviceId: string, why: UploadRefusal): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      const exists = await tx.gateDevice.count({ where: { id: deviceId } });
      if (!exists) return;
      await this.devices.lock(tx, deviceId);
      const device = await this.devices.row(tx, deviceId);
      const now = await dbNow(tx);
      await this.audit.record(tx, {
        action: 'gate_offline.upload_rejected',
        targetId: deviceId,
        metadata: { reason: why },
      });
      if (
        device.rejectionAlertedAt &&
        now.getTime() - device.rejectionAlertedAt.getTime() < REJECTION_ALERT_MS
      )
        return;
      await this.safety.notify(
        tx,
        await this.safety.holding(tx, 'gate_devices.manage'),
        'gate_device.upload_rejected',
        deviceId,
        { reason: why },
      );
      await tx.gateDevice.update({
        where: { id: deviceId },
        data: { rejectionAlertedAt: now },
      });
    });
  }
}

/** Whether an error opening the envelope is the device's: audited, told. */
function refusalOf(e: unknown): UploadRefusal | null {
  if (!(e instanceof AppException)) return null;
  const code = e.code as string;
  if (code === ErrorCode.GATE_DEVICE_SIGNATURE_INVALID) return 'signature';
  if (code === ErrorCode.GATE_DEVICE_ENVELOPE_INVALID) return 'envelope';
  return null;
}
