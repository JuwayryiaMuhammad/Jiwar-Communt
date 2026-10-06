import type { TenantTxClient } from '../../core/database/tenant-tx.service';

// ============================================================================
// The standing lock order (ADR 0036): accounts first, then units.
//
// An erasure executing for an account holds its row FOR UPDATE and then
// locks the units it leaves. Whatever may make an account a unit's primary,
// or end or deactivate it on a unit, takes the account rows BEFORE any unit
// lock, so the two always serialize in the same order and never deadlock.
// ============================================================================

/**
 * One account's row, shared (FOR KEY SHARE): enough to keep an erasure
 * from running under a write that will point at it. Returns its status, or
 * null when it is not visible.
 */
export async function lockAccountShared(
  tx: TenantTxClient,
  accountId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM accounts
     WHERE id = ${accountId}::uuid FOR KEY SHARE`;
  return rows[0]?.status ?? null;
}

/**
 * Several accounts' rows, FOR UPDATE, in id order (so two callers locking
 * overlapping sets never deadlock either): for a write that may change
 * them — deactivate a member, end an occupant — besides pointing at them.
 */
export async function lockAccountsForUpdate(
  tx: TenantTxClient,
  accountIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(accountIds)].sort();
  if (!ids.length) return;
  await tx.$queryRaw`
    SELECT id FROM accounts WHERE id = ANY(${ids}::uuid[])
     ORDER BY id FOR UPDATE`;
}
