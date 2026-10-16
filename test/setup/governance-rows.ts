import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

// ============================================================================
// Governance rows written straight into the tables (ADR 0051), for the
// suites that test the database itself: the schema and isolation suites.
// Each returns the row's id.
// ============================================================================

const DAY = 86_400_000;

/**
 * A board term that ended already (a compound holds one open term at most,
 * so a row helper never leaves one open unless asked).
 */
export async function boardTermRow(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string; open?: boolean },
): Promise<string> {
  const id = newId();
  const startsAt = new Date(Date.now() - 400 * DAY);
  await tx.boardTerm.create({
    data: {
      id,
      tenantId: r.tenantId,
      source: 'appointed',
      seats: 3,
      startsAt,
      endsAt: new Date(Date.now() + (r.open ? 365 : -35) * DAY),
      ...(r.open
        ? {}
        : { endedAt: new Date(Date.now() - 35 * DAY), endReason: 'replaced' }),
      createdById: r.createdById,
      createdAt: startsAt,
    },
  });
  return id;
}

export async function boardMemberRow(
  tx: TenantTxClient,
  r: { tenantId: string; termId: string; accountId: string; addedById: string },
): Promise<string> {
  const id = newId();
  await tx.boardMember.create({
    data: {
      id,
      tenantId: r.tenantId,
      termId: r.termId,
      accountId: r.accountId,
      role: 'member',
      addedAt: new Date(Date.now() - 400 * DAY),
      addedById: r.addedById,
    },
  });
  return id;
}
