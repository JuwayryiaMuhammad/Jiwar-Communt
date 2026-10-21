import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { GateDevice } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { instantOf } from '../../core/common/validation/instant';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import {
  decodePayload,
  envelopeMessage,
  signatureDigest,
  signedBy,
} from './device-envelope';
import { deviceNotFound, GateDevicesService } from './gate-devices.service';

/** How far an envelope's `sentAt` may be from the server's clock, either way. */
export const ENVELOPE_WINDOW_MS = 24 * 3_600_000;
export const DEVICE_ENVELOPES_SWEEP = 'gate.device_envelopes';

export type EnvelopePurpose = 'bundle' | 'heartbeat' | 'upload';

/** What a device sends: its id, the payload's JSON in base64url, its signature. */
export interface DeviceEnvelope {
  deviceId: string;
  payload: string;
  signature: string;
}

export interface OpenedEnvelope {
  /** The device's row, read again under its lock. */
  device: GateDevice;
  payload: Record<string, unknown>;
  /** The device's clock when it signed. */
  sentAt: Date;
  /** The database's clock, after the device's lock. */
  now: Date;
}

export type EnvelopeProblem =
  'payload' | 'purpose' | 'tenant' | 'device' | 'sent_at';

const invalid = (reason: EnvelopeProblem) =>
  appError.unprocessable(
    ErrorCode.GATE_DEVICE_ENVELOPE_INVALID,
    'The envelope does not say what this call needs',
    { params: { reason } },
  );

export const deviceRevoked = () =>
  appError.forbidden(ErrorCode.GATE_DEVICE_REVOKED, 'This device was revoked');

/**
 * Opens what a guard device signed (ADR 0057), in the caller's
 * transaction:
 *
 * 1. the device, by its id in this compound (404 otherwise);
 * 2. the signature over the payload as sent (422 GATE_DEVICE_SIGNATURE_INVALID);
 * 3. the payload: a JSON object for this purpose, this compound and this
 *    device, with a `sentAt` (422 GATE_DEVICE_ENVELOPE_INVALID);
 * 4. the device's row FOR UPDATE: after the caller's account and shift;
 * 5. `sentAt` within a day of the database's clock, either way;
 * 6. for a bundle and a heartbeat, the replay guard: the same envelope
 *    twice is 409 GATE_DEVICE_ENVELOPE_REPLAYED. An upload is guarded by
 *    its actions' ids and sequence numbers instead, so a retried batch
 *    answers what it recorded.
 *
 * A revoked device opens like any: the caller decides (a bundle refuses
 * it, an upload quarantines what it says).
 */
@Injectable()
export class DeviceEnvelopes implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly devices: GateDevicesService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    // A row goes once both its receipt and its `sentAt` are a day old: a
    // replay of it after that is refused by its `sentAt` anyway.
    this.sweep.register(DEVICE_ENVELOPES_SWEEP, (now) =>
      this.sweep.forEachTenant(
        (tx) => tx.$executeRaw`
          DELETE FROM gate_device_envelopes
           WHERE GREATEST(sent_at, received_at) < ${new Date(now.getTime() - ENVELOPE_WINDOW_MS)}`,
      ),
    );
  }

  async open(
    tx: TenantTxClient,
    envelope: DeviceEnvelope,
    purpose: EnvelopePurpose,
  ): Promise<OpenedEnvelope> {
    const found = await tx.gateDevice.findUnique({
      where: { id: envelope.deviceId },
    });
    if (!found) throw deviceNotFound();
    if (
      !signedBy(
        found.publicKey,
        envelopeMessage(envelope.payload),
        envelope.signature,
      )
    )
      throw appError.unprocessable(
        ErrorCode.GATE_DEVICE_SIGNATURE_INVALID,
        'The device’s signature does not verify',
      );
    const payload = decodePayload(envelope.payload);
    if (!payload) throw invalid('payload');
    if (payload.purpose !== purpose) throw invalid('purpose');
    if (payload.tenantId !== this.ctx.txTenantId) throw invalid('tenant');
    if (payload.deviceId !== envelope.deviceId) throw invalid('device');
    // With its offset (ADR 0025): a time without one names no instant.
    const sentAt = instantOf(payload.sentAt);
    if (!sentAt) throw invalid('sent_at');
    await this.devices.lock(tx, found.id);
    const device = await this.devices.row(tx, found.id);
    const now = await dbNow(tx);
    if (Math.abs(sentAt.getTime() - now.getTime()) >= ENVELOPE_WINDOW_MS)
      throw invalid('sent_at');
    if (purpose !== 'upload') {
      const kept = await tx.$executeRaw`
        INSERT INTO gate_device_envelopes
          (tenant_id, device_id, signature_sha256, sent_at, received_at)
        VALUES (${this.ctx.txTenantId}::uuid, ${device.id}::uuid,
                ${signatureDigest(envelope.signature)}, ${sentAt}, ${now})
        ON CONFLICT DO NOTHING`;
      if (!kept)
        throw appError.conflict(
          ErrorCode.GATE_DEVICE_ENVELOPE_REPLAYED,
          'This envelope was received already',
        );
    }
    return { device, payload, sentAt, now };
  }
}
