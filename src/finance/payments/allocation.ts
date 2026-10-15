import { Prisma } from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { CREDITED_SQL, PAID_SQL } from '../invoices/balances';
import { money, ZERO } from '../money';

/** What a live payment still has to give. */
interface FreeMoney {
  id: string;
  free: Prisma.Decimal;
}

/** What an invoice still asks for. */
interface Owed {
  id: string;
  owed: Prisma.Decimal;
}

/**
 * The live payments of a unit with money not yet allocated, oldest paid
 * first (a reversed payment gives nothing).
 */
async function freeMoney(
  tx: TenantTxClient,
  unitId: string,
  only?: string,
): Promise<FreeMoney[]> {
  const rows = await tx.$queryRaw<{ id: string; free: Prisma.Decimal }[]>`
    SELECT p.id,
           p.amount - COALESCE((SELECT SUM(a.amount) FROM finance_allocations a
                                 WHERE a.tenant_id = p.tenant_id AND a.payment_id = p.id), 0) AS free
      FROM finance_payments p
     WHERE p.unit_id = ${unitId}::uuid AND p.kind = 'payment'
       AND NOT EXISTS (SELECT 1 FROM finance_payments r
                        WHERE r.tenant_id = p.tenant_id AND r.reverses_id = p.id)
       ${only ? Prisma.sql`AND p.id = ${only}::uuid` : Prisma.empty}
     ORDER BY p.paid_on, p.created_at, p.id`;
  return rows
    .map((r) => ({ id: r.id, free: money(r.free) }))
    .filter((r) => r.free.gt(ZERO));
}

/** The unit's invoices still owed, oldest due first (then by number). */
async function owed(
  tx: TenantTxClient,
  unitId: string,
  only?: readonly string[],
): Promise<Owed[]> {
  const rows = await tx.$queryRaw<{ id: string; owed: Prisma.Decimal }[]>`
    SELECT i.id, i.total - ${CREDITED_SQL} - ${PAID_SQL} AS owed
      FROM invoices i
     WHERE i.unit_id = ${unitId}::uuid
       ${only ? Prisma.sql`AND i.id = ANY(${[...only]}::uuid[])` : Prisma.empty}
     ORDER BY i.due_on, i.number`;
  return rows
    .map((r) => ({ id: r.id, owed: money(r.owed) }))
    .filter((r) => r.owed.gt(ZERO));
}

/** Pours `money` into `invoices` in order; the allocation rows to insert. */
function pour(
  tenantId: string,
  payments: FreeMoney[],
  invoices: Owed[],
): Prisma.FinanceAllocationCreateManyInput[] {
  const rows: Prisma.FinanceAllocationCreateManyInput[] = [];
  let i = 0;
  for (const p of payments) {
    while (p.free.gt(ZERO) && i < invoices.length) {
      const inv = invoices[i];
      const take = Prisma.Decimal.min(p.free, inv.owed);
      rows.push({
        id: newId(),
        tenantId,
        paymentId: p.id,
        invoiceId: inv.id,
        amount: take,
      });
      p.free = p.free.sub(take);
      inv.owed = inv.owed.sub(take);
      if (inv.owed.lte(ZERO)) i += 1;
    }
  }
  return rows;
}

/**
 * Allocation (ADR 0046), oldest due first, as append-only rows. Call under
 * the unit's finance lock (FinanceAccess.lockUnits): two writers never pour
 * into one balance at once, and the commit-time bounds would catch it.
 *
 * - `applyPayment`: a new payment covers the invoices it named first (a
 *   checkout's, or those the office picked), then the unit's others;
 * - `allocateUnit`: any of the unit's free money (credit) covers its owed
 *   invoices — after an issue, a reversal, a late payment.
 *
 * Both are idempotent: a second run finds nothing free or nothing owed.
 * Returns the allocations written.
 */
export async function applyPayment(
  tx: TenantTxClient,
  tenantId: string,
  unitId: string,
  paymentId: string,
  named: readonly string[],
): Promise<number> {
  const payment = await freeMoney(tx, unitId, paymentId);
  let rows: Prisma.FinanceAllocationCreateManyInput[] = [];
  if (named.length)
    rows = pour(tenantId, payment, await owed(tx, unitId, named));
  if (rows.length) await tx.financeAllocation.createMany({ data: rows });
  return rows.length + (await allocateUnit(tx, tenantId, unitId));
}

export async function allocateUnit(
  tx: TenantTxClient,
  tenantId: string,
  unitId: string,
): Promise<number> {
  const rows = pour(
    tenantId,
    await freeMoney(tx, unitId),
    await owed(tx, unitId),
  );
  if (rows.length) await tx.financeAllocation.createMany({ data: rows });
  return rows.length;
}

/** The unit's credit: live payments not allocated to any invoice. */
export async function unitCredit(
  tx: TenantTxClient,
  unitId: string,
): Promise<Prisma.Decimal> {
  return (await freeMoney(tx, unitId)).reduce(
    (sum, p) => sum.add(p.free),
    ZERO,
  );
}

/**
 * After an issue: the units among `unitIds` holding credit pay their new
 * invoices with it at once (one query finds them, however many units).
 */
export async function allocateUnits(
  tx: TenantTxClient,
  tenantId: string,
  unitIds: readonly string[],
): Promise<number> {
  if (!unitIds.length) return 0;
  const withCredit = await tx.$queryRaw<{ unit_id: string }[]>`
    SELECT DISTINCT p.unit_id FROM finance_payments p
     WHERE p.unit_id = ANY(${[...unitIds]}::uuid[]) AND p.kind = 'payment'
       AND NOT EXISTS (SELECT 1 FROM finance_payments r
                        WHERE r.tenant_id = p.tenant_id AND r.reverses_id = p.id)
       AND p.amount > COALESCE((SELECT SUM(a.amount) FROM finance_allocations a
                                 WHERE a.tenant_id = p.tenant_id AND a.payment_id = p.id), 0)
     ORDER BY p.unit_id`;
  let n = 0;
  for (const { unit_id } of withCredit)
    n += await allocateUnit(tx, tenantId, unit_id);
  return n;
}
