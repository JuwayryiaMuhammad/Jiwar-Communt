import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';

/**
 * Makes the units' open checkouts stale after the staff changed what they
 * cover (a credit note, an office payment), in the caller's transaction and
 * under its finance locks (ADR 0046). A payer who still completes the old
 * page is applied as a late payment; what nothing owed absorbs becomes the
 * unit's credit.
 */
export async function supersedeLive(
  tx: TenantTxClient,
  unitIds: readonly string[],
): Promise<void> {
  if (!unitIds.length) return;
  await tx.paymentSession.updateMany({
    where: { unitId: { in: [...unitIds] }, status: 'open' },
    data: { status: 'superseded', resolvedAt: await dbNow(tx) },
  });
}
