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
 * Several accounts' rows, FOR NO KEY UPDATE, in id order (so two callers
 * locking overlapping sets never deadlock either): for a write that may
 * change them — deactivate a member, end an occupant — besides pointing at
 * them. An erasure (FOR UPDATE) and an account's own share lock still wait.
 *
 * Not `FOR UPDATE`: that also stops every foreign-key check on the accounts
 * (`FOR KEY SHARE`). A payment holds finance's lock on the unit and then
 * tells the unit's people (a notice names each account): an ownership
 * transfer holding them FOR UPDATE and reaching for that same finance lock
 * (its dues gate, ADR 0083) deadlocked with it. An account's key never
 * changes, so the checks have nothing to wait for (as with units).
 */
export async function lockAccountsForUpdate(
  tx: TenantTxClient,
  accountIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(accountIds)].sort();
  if (!ids.length) return;
  await tx.$queryRaw`
    SELECT id FROM accounts WHERE id = ANY(${ids}::uuid[])
     ORDER BY id FOR NO KEY UPDATE`;
}
