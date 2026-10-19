import type { GateDevice } from '@prisma/client';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * How many of a device's sequence numbers, up to its highest received,
 * never arrived (ADR 0057): actions lost, or deleted on the device.
 */
export async function missingActions(
  tx: TenantTxClient,
  d: Pick<GateDevice, 'id' | 'ackedSeq' | 'maxSeq'>,
): Promise<number> {
  if (d.maxSeq <= d.ackedSeq) return 0;
  const present = await tx.gateOfflineAction.count({
    where: { deviceId: d.id, seq: { gt: d.ackedSeq, lte: d.maxSeq } },
  });
  return d.maxSeq - d.ackedSeq - present;
}
