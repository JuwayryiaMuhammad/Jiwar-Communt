import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { day, dbDate } from './compound-clock';

/**
 * Raw rows of the general ledger (ADR 0092), written straight through the
 * tenant client: for the database-level suites (RLS isolation, the API's
 * foreign ids). The chart is seeded first when the compound has none.
 */

/** A system account's id, by its key. */
export async function glAccountId(
  tx: TenantTxClient,
  tenantId: string,
  key: string,
): Promise<string> {
  const [{ id }] = await tx.$queryRaw<{ id: string }[]>`
    SELECT gl_account(${tenantId}::uuid, ${key})::text AS id`;
  return id;
}

let counter = 0;

/** A pending manual entry of 100 from suspense to opening balances: its id. */
export async function glManualEntryRow(
  tx: TenantTxClient,
  r: { tenantId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.glManualEntry.create({
    data: {
      id,
      tenantId: r.tenantId,
      number: 900_000 + (Date.now() % 90_000) + ++counter,
      postedOn: dbDate(day(0)),
      memo: 'A test entry',
      createdByAccountId: r.createdById,
      createdAt: new Date(),
    },
  });
  await tx.glManualEntryLine.createMany({
    data: [
      {
        tenantId: r.tenantId,
        manualEntryId: id,
        lineNo: 1,
        accountId: await glAccountId(tx, r.tenantId, 'suspense'),
        debit: '100.00',
      },
      {
        tenantId: r.tenantId,
        manualEntryId: id,
        lineNo: 2,
        accountId: await glAccountId(tx, r.tenantId, 'opening_balances'),
        credit: '100.00',
      },
    ],
  });
  return id;
}

/** A posted entry of the compound's (an automatic one), the first by its order. */
export async function glEntryId(tx: TenantTxClient): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM gl_entries ORDER BY seq LIMIT 1`;
  if (!rows[0]) throw new Error('no gl entry yet');
  return rows[0].id;
}
