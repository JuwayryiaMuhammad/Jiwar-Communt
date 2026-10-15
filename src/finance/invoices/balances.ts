import { Prisma } from '@prisma/client';
import type { LocalDate } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { fromDate } from '../db-clock';
import { money, ZERO } from '../money';

/**
 * Where an invoice stands (ADR 0046), always computed:
 * - `credited`: credit notes cover it, and nothing was paid;
 * - `paid`: nothing is owed, and something was paid;
 * - `overdue`: something is owed after the due date (the compound's day);
 * - `partially_paid` / `unpaid`: something is owed, before the due date.
 */
export const INVOICE_STATUSES = [
  'unpaid',
  'partially_paid',
  'overdue',
  'paid',
  'credited',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** The statuses a list filters by: these, and `open` (anything still owed). */
export const INVOICE_FILTERS = [...INVOICE_STATUSES, 'open'] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

export interface Balance {
  total: Prisma.Decimal;
  credited: Prisma.Decimal;
  paid: Prisma.Decimal;
  outstanding: Prisma.Decimal;
}

/**
 * What credit notes and live payments took off invoice `i`, as SQL. Every
 * read and every decision uses this one fragment, so they cannot disagree.
 */
export const CREDITED_SQL = Prisma.sql`COALESCE((
  SELECT SUM(c.amount) FROM credit_notes c
   WHERE c.tenant_id = i.tenant_id AND c.invoice_id = i.id), 0)`;
export const PAID_SQL = Prisma.sql`COALESCE((
  SELECT SUM(a.amount) FROM finance_allocations a
   WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id
     AND NOT EXISTS (SELECT 1 FROM finance_payments r
                      WHERE r.tenant_id = a.tenant_id AND r.reverses_id = a.payment_id)), 0)`;

export function statusOf(
  b: Balance,
  dueOn: LocalDate,
  today: LocalDate,
): InvoiceStatus {
  if (b.outstanding.lte(ZERO)) return b.paid.gt(ZERO) ? 'paid' : 'credited';
  if (dueOn < today) return 'overdue';
  return b.paid.gt(ZERO) ? 'partially_paid' : 'unpaid';
}

/** The filter as SQL over `credited`, `paid`, `total` and `due_on`. */
export function filterSql(filter: InvoiceFilter, today: LocalDate): Prisma.Sql {
  const owed = Prisma.sql`(b.total - b.credited - b.paid) > 0`;
  switch (filter) {
    case 'open':
      return owed;
    case 'overdue':
      return Prisma.sql`${owed} AND b.due_on < ${today}::date`;
    case 'unpaid':
      return Prisma.sql`${owed} AND b.paid = 0 AND b.due_on >= ${today}::date`;
    case 'partially_paid':
      return Prisma.sql`${owed} AND b.paid > 0 AND b.due_on >= ${today}::date`;
    case 'paid':
      return Prisma.sql`NOT ${owed} AND b.paid > 0`;
    case 'credited':
      return Prisma.sql`NOT ${owed} AND b.paid = 0`;
  }
}

/** The balances of some invoices, by id. */
export async function balancesOf(
  tx: TenantTxClient,
  invoiceIds: readonly string[],
): Promise<Map<string, Balance & { dueOn: LocalDate }>> {
  if (!invoiceIds.length) return new Map();
  const rows = await tx.$queryRaw<
    {
      id: string;
      total: Prisma.Decimal;
      credited: Prisma.Decimal;
      paid: Prisma.Decimal;
      due_on: Date;
    }[]
  >`
    SELECT i.id, i.total, ${CREDITED_SQL} AS credited, ${PAID_SQL} AS paid, i.due_on
      FROM invoices i
     WHERE i.id = ANY(${[...invoiceIds]}::uuid[])`;
  return new Map(
    rows.map((r) => {
      const total = money(r.total);
      const credited = money(r.credited);
      const paid = money(r.paid);
      return [
        r.id,
        {
          total,
          credited,
          paid,
          outstanding: total.sub(credited).sub(paid),
          dueOn: fromDate(r.due_on),
        },
      ];
    }),
  );
}
