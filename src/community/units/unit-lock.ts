import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * Row-locks units (SELECT … FOR NO KEY UPDATE) for the rest of the
 * transaction, in a stable order so two transactions never wait on each
 * other. Everything that counts or changes what hangs off a unit —
 * occupancies and the primary resident, household size, delegations — takes
 * this lock first, and two holders exclude each other.
 *
 * Not `FOR UPDATE`: that lock also stops every foreign-key check on the unit
 * (`FOR KEY SHARE`), so a write that merely names the unit — a request, a
 * booking — waited on it. Such a write holds its author's account row; the
 * holder of the unit lock then reaches for that account (removing a member,
 * ending an occupancy) and the two deadlocked. A unit's key never changes,
 * so the checks have nothing to wait for.
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
     ORDER BY id FOR NO KEY UPDATE`;
  const missing = ids.filter((id) => !locked.some((u) => u.id === id));
  if (missing.length) {
    throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found', {
      params: { unitIds: missing },
    });
  }
}
