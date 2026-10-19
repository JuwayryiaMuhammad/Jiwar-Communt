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
