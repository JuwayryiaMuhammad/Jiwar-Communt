import { createHash } from 'node:crypto';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// Raw rows of the patrol tables (ADR 0052), for the schema and isolation
// suites: the shortest valid row of each.

/** A token hash's shape: what the column takes (the hash of anything). */
export const rowHash = (seed: string) =>
  createHash('sha256').update(seed).digest('hex');

/** A checkpoint in service at a gate (or a zone), without a position. */
export async function checkpointRow(
  tx: TenantTxClient,
  r: {
    tenantId: string;
    gateId?: string;
    placeId?: string;
    createdById: string;
  },
): Promise<string> {
  const id = newId();
  await tx.patrolCheckpoint.create({
    data: {
      id,
      tenantId: r.tenantId,
      gateId: r.placeId ? null : (r.gateId ?? null),
      placeId: r.placeId ?? null,
      nameEn: `Row point ${id.slice(-8)}`,
      nameAr: `نقطة ${id.slice(-8)}`,
      tokenHash: rowHash(id),
      tokenIssuedAt: new Date(),
      createdById: r.createdById,
    },
  });
  return id;
}
