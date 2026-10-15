import { Prisma } from '@prisma/client';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import {
  CREDITED_SQL,
  DISPUTED_SQL,
  PAID_SQL,
  RELEASED_SQL,
} from '../invoices/balances';
import { money, ZERO } from '../money';

/** What a live payment still has to give. */
export interface FreeMoney {
  id: string;
  free: Prisma.Decimal;
}

/** What an invoice still asks for. */
interface Owed {
  id: string;
  owed: Prisma.Decimal;
}

/**
 * What live payment `p` still has to give, as SQL: its amount less what it
 * paid to invoices (net of releases) and what live refunds took from it
 * (ADR 0048). Every
 * reader of free money — the allocator, the unit's credit, a payment's
 * view — uses this one fragment, so the allocator never pours money that
 * was paid back.
 */
export const FREE_SQL = Prisma.sql`(p.amount
  - COALESCE((SELECT SUM(a.amount - ${RELEASED_SQL}) FROM finance_allocations a
               WHERE a.tenant_id = p.tenant_id AND a.payment_id = p.id), 0)
  - COALESCE((SELECT SUM(s.amount) FROM finance_refund_sources s
               WHERE s.tenant_id = p.tenant_id AND s.payment_id = p.id
                 AND NOT EXISTS (SELECT 1 FROM finance_refunds x
                                  WHERE x.tenant_id = s.tenant_id
                                    AND x.reverses_id = s.refund_id)), 0))`;

/** A payment of `p`'s that is live: a payment, and not reversed. */
const LIVE_SQL = Prisma.sql`p.kind = 'payment'
  AND NOT EXISTS (SELECT 1 FROM finance_payments r
                   WHERE r.tenant_id = p.tenant_id AND r.reverses_id = p.id)`;

/**
 * The live payments of a unit with money not yet allocated or refunded,
 * oldest paid first (a reversed payment gives nothing).
 */
export async function freeMoney(
  tx: TenantTxClient,
  unitId: string,
  only?: string,
  order: 'oldest' | 'newest' = 'oldest',
): Promise<FreeMoney[]> {
  const rows = await tx.$queryRaw<{ id: string; free: Prisma.Decimal }[]>`
    SELECT p.id, ${FREE_SQL} AS free
      FROM finance_payments p
     WHERE p.unit_id = ${unitId}::uuid AND ${LIVE_SQL}
       ${only ? Prisma.sql`AND p.id = ${only}::uuid` : Prisma.empty}
     ORDER BY ${
       order === 'oldest'
         ? Prisma.sql`p.paid_on, p.created_at, p.id`
         : Prisma.sql`p.paid_on DESC, p.created_at DESC, p.id DESC`
     }`;
  return rows
    .map((r) => ({ id: r.id, free: money(r.free) }))
    .filter((r) => r.free.gt(ZERO));
}

/**
 * The unit's invoices still owed, oldest due first (then by number). Only
 * the invoices a payment names when `only` is given; otherwise none under
 * an open dispute (ADR 0048): credit never pays what the unit contests.
 */
async function owed(
  tx: TenantTxClient,
  unitId: string,
  only?: readonly string[],
): Promise<Owed[]> {
  const rows = await tx.$queryRaw<{ id: string; owed: Prisma.Decimal }[]>`
    SELECT i.id, i.total - ${CREDITED_SQL} - ${PAID_SQL} AS owed
      FROM invoices i
     WHERE i.unit_id = ${unitId}::uuid
       ${only ? Prisma.sql`AND i.id = ANY(${[...only]}::uuid[])` : Prisma.sql`AND NOT ${DISPUTED_SQL}`}
     ORDER BY i.due_on, i.number`;
  return rows
    .map((r) => ({ id: r.id, owed: money(r.owed) }))
    .filter((r) => r.owed.gt(ZERO));
}

/**
 * Pours `money` into `invoices` in order; the allocation rows to insert.
 * Money of any payment but `fresh` (the one taken in this transaction) was
 * already the unit's credit: its rows are marked `fromCredit`, which the
 * ledger shows as "credit applied" (ADR 0048).
 */
export function pour(
  tenantId: string,
  payments: FreeMoney[],
  invoices: Owed[],
  fresh?: string,
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
        fromCredit: p.id !== fresh,
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
    rows = pour(tenantId, payment, await owed(tx, unitId, named), paymentId);
  if (rows.length) await tx.financeAllocation.createMany({ data: rows });
  return rows.length + (await allocate(tx, tenantId, unitId, paymentId));
}

export async function allocateUnit(
  tx: TenantTxClient,
  tenantId: string,
  unitId: string,
): Promise<number> {
  return allocate(tx, tenantId, unitId);
}

/** The unit's free money into its owed invoices; `fresh` as in `pour`. */
async function allocate(
  tx: TenantTxClient,
  tenantId: string,
  unitId: string,
  fresh?: string,
): Promise<number> {
  const rows = pour(
    tenantId,
    await freeMoney(tx, unitId),
    await owed(tx, unitId),
    fresh,
  );
  if (rows.length) await tx.financeAllocation.createMany({ data: rows });
  return rows.length;
}

/**
 * Gives `amount` of the invoice's newest live allocations back to the
 * unit's credit, against credit note `creditNoteId` (ADR 0048): a credit
 * note took off more than the invoice still owed. Under the unit's finance
 * lock; the caller checked the invoice has that much paid.
 */
export async function releaseNewest(
  tx: TenantTxClient,
  tenantId: string,
  invoiceId: string,
  creditNoteId: string,
  amount: Prisma.Decimal,
): Promise<number> {
  const live = await tx.$queryRaw<{ id: string; left: Prisma.Decimal }[]>`
    SELECT a.id, a.amount - ${RELEASED_SQL} AS left
      FROM finance_allocations a
     WHERE a.invoice_id = ${invoiceId}::uuid
       AND NOT EXISTS (SELECT 1 FROM finance_payments r
                        WHERE r.tenant_id = a.tenant_id AND r.reverses_id = a.payment_id)
     ORDER BY a.created_at DESC, a.id DESC`;
  const rows: Prisma.FinanceAllocationReleaseCreateManyInput[] = [];
  let left = amount;
  for (const a of live) {
    if (left.lte(ZERO)) break;
    const room = money(a.left);
    if (room.lte(ZERO)) continue;
    const take = Prisma.Decimal.min(room, left);
    rows.push({
      id: newId(),
      tenantId,
      allocationId: a.id,
      creditNoteId,
      amount: take,
    });
    left = left.sub(take);
  }
  if (rows.length) await tx.financeAllocationRelease.createMany({ data: rows });
  return rows.length;
}

/**
 * The unit's credit: what live payments gave to no invoice and no live
 * refund took.
 */
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
     WHERE p.unit_id = ANY(${[...unitIds]}::uuid[]) AND ${LIVE_SQL}
       AND ${FREE_SQL} > 0
     ORDER BY p.unit_id`;
  let n = 0;
  for (const { unit_id } of withCredit)
    n += await allocateUnit(tx, tenantId, unit_id);
  return n;
}
