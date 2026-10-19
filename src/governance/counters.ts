import type { TenantTxClient } from '../core/database/tenant-tx.service';

/** What governance numbers per compound (ADR 0051, 0055). */
export type GovernanceCounterKind = 'poll' | 'election' | 'approval' | 'appeal';

/**
 * The next number of `kind` in the compound. The counter row stays locked
 * to commit and a rollback gives the number back: numbers are gapless.
 * A transaction takes one kind only.
 */
export async function nextGovernanceNumber(
  tx: TenantTxClient,
  tenantId: string,
  kind: GovernanceCounterKind,
): Promise<number> {
  const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
    INSERT INTO governance_counters (tenant_id, kind, last_number)
    VALUES (${tenantId}::uuid, ${kind}, 1)
    ON CONFLICT (tenant_id, kind)
      DO UPDATE SET last_number = governance_counters.last_number + 1
    RETURNING last_number AS number`;
  return number;
}
