import { generateKeyPairSync } from 'node:crypto';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// Raw rows of the gate offline's tables (ADR 0057), for the schema and
// isolation suites: the shortest valid row of each. Instants are written
// out, never read from a clock.

export const OFFLINE_T0 = new Date('2026-11-06T09:00:00.000Z');
export const offlineAt = (minutes: number) =>
  new Date(OFFLINE_T0.getTime() + minutes * 60_000);

/** A fresh Ed25519 public key, as a device registers it. */
export const publicKeyOf = (): string =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;

/** A live device enrolled at T0 by `enrolledById`. */
export async function deviceRow(
  tx: TenantTxClient,
  r: { tenantId: string; enrolledById: string; revokedById?: string },
): Promise<string> {
  const id = newId();
  await tx.gateDevice.create({
    data: {
      id,
      tenantId: r.tenantId,
      publicKey: publicKeyOf(),
      enrolledById: r.enrolledById,
      enrolledAt: OFFLINE_T0,
      ...(r.revokedById
        ? {
            revokedAt: offlineAt(60),
            revokedById: r.revokedById,
            revokeReason: 'lost',
          }
        : {}),
    },
  });
  return id;
}

let bundles = 0;

/** A bundle the device downloaded at T0, valid twelve hours. */
export async function bundleRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    deviceId: string;
    shiftId: string;
    gateId: string;
    guardId: string;
  },
): Promise<string> {
  const id = newId();
  await tx.gateOfflineBundle.create({
    data: {
      id,
      tenantId: r.tenantId,
      deviceId: r.deviceId,
      version: ++bundles,
      shiftId: r.shiftId,
      gateId: r.gateId,
      guardAccountId: r.guardId,
      issuedAt: OFFLINE_T0,
      validUntil: offlineAt(12 * 60),
      keyVersion: 1,
      contentSha256: 'a'.repeat(64),
      counts: { passes: 0 },
    },
  });
  return id;
}

let envelopes = 0;

/** An envelope the device sent at T0: its signature's hash. */
export async function envelopeRow(
  tx: TenantTxClient,
  r: { tenantId: string; deviceId: string },
): Promise<string> {
  const hex = (++envelopes).toString(16).padStart(64, '0');
  await tx.gateDeviceEnvelope.create({
    data: {
      tenantId: r.tenantId,
      deviceId: r.deviceId,
      signatureSha256: hex,
      sentAt: OFFLINE_T0,
      receivedAt: OFFLINE_T0,
    },
  });
  return hex;
}
