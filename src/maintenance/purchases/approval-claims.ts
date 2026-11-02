import type { TenantTxClient } from '../../core/database/tenant-tx.service';

/**
 * One claim of a board approval at a time (ADR 0077): a contract and a
 * purchase request each check that no other contract or request names the
 * approval, then name it, in two tables with no unique index across them;
 * this lock, taken after the approval's row is shared, makes the check and
 * the write one step. Released at commit.
 */
export async function claimApproval(
  tx: TenantTxClient,
  tenantId: string,
  approvalRequestId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`approval-claim:${tenantId}:${approvalRequestId}`}))`;
}
