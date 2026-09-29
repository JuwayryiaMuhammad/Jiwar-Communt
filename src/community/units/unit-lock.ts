import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Row-locks units (SELECT … FOR UPDATE) for the rest of the transaction, in
 * a stable order so two transactions never wait on each other. Everything
 * that counts or changes what hangs off a unit — occupancies and the primary
 * resident, household size, delegations — takes this lock first.
 *
 * Units of another compound are invisible under RLS, so they are "not
 * found" like missing ones.
 */
export async function lockUnits(
  tx: TenantTxClient,
  unitIds: string[],
): Promise<void> {
  const ids = [...new Set(unitIds)].sort();
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM units WHERE id = ANY(${ids}::uuid[])
     ORDER BY id FOR UPDATE`;
  const missing = ids.filter((id) => !locked.some((u) => u.id === id));
  if (missing.length) {
    throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found', {
      params: { unitIds: missing },
    });
  }
}
