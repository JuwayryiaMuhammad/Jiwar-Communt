import { Prisma } from '@prisma/client';
import type { LocalDate } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { fromDate } from '../db-clock';
import { money, ZERO } from '../money';

/**
 * Where an invoice stands (ADR 0046), always computed:
 * - `rescheduled`: nothing is owed, and an instalment plan took it over
 *   (ADR 0048: the plan's credit note closed it, whatever was paid before);
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
  'rescheduled',
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
  /** An instalment plan's credit note closed it (ADR 0048). */
  rescheduled: boolean;
}

/**
 * What credit notes gave back of allocation `a` to the unit's credit (ADR
 * 0048): an allocation counts net of its releases everywhere.
 */
export const RELEASED_SQL = Prisma.sql`COALESCE((
  SELECT SUM(x.amount) FROM finance_allocation_releases x
   WHERE x.tenant_id = a.tenant_id AND x.allocation_id = a.id), 0)`;

/**
 * What credit notes and live payments took off invoice `i`, as SQL. Every
 * read and every decision uses this one fragment, so they cannot disagree.
 */
export const CREDITED_SQL = Prisma.sql`COALESCE((
  SELECT SUM(c.amount) FROM credit_notes c
   WHERE c.tenant_id = i.tenant_id AND c.invoice_id = i.id), 0)`;
export const PAID_SQL = Prisma.sql`COALESCE((
  SELECT SUM(a.amount - ${RELEASED_SQL}) FROM finance_allocations a
   WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id
     AND NOT EXISTS (SELECT 1 FROM finance_payments r
                      WHERE r.tenant_id = a.tenant_id AND r.reverses_id = a.payment_id)), 0)`;
/**
 * Invoice `i` is under an open dispute (ADR 0048): frozen — no reminder, no
 * automatic allocation, no payment or credit note naming it.
 */
export const DISPUTED_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM invoice_disputes d
   WHERE d.tenant_id = i.tenant_id AND d.invoice_id = i.id
     AND d.status = 'open')`;

/** Of these invoices, those under an open dispute. */
export async function disputedAmong(
  tx: TenantTxClient,
  invoiceIds: readonly string[],
): Promise<string[]> {
  if (!invoiceIds.length) return [];
  const rows = await tx.invoiceDispute.findMany({
    where: { invoiceId: { in: [...invoiceIds] }, status: 'open' },
    select: { invoiceId: true },
  });
  return invoiceIds.filter((id) => rows.some((r) => r.invoiceId === id));
}

/** An instalment plan took invoice `i` over (opened on it, or cancelled it). */
export const RESCHEDULED_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM credit_notes c
   WHERE c.tenant_id = i.tenant_id AND c.invoice_id = i.id
     AND c.reason_code = 'instalment_plan')`;

export function statusOf(
  b: Balance,
  dueOn: LocalDate,
  today: LocalDate,
): InvoiceStatus {
  if (b.outstanding.lte(ZERO)) {
    if (b.rescheduled) return 'rescheduled';
    return b.paid.gt(ZERO) ? 'paid' : 'credited';
  }
  if (dueOn < today) return 'overdue';
  return b.paid.gt(ZERO) ? 'partially_paid' : 'unpaid';
}

/**
 * The filter as SQL over `credited`, `paid`, `rescheduled`, `total` and
 * `due_on`.
 */
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
      return Prisma.sql`NOT ${owed} AND b.paid > 0 AND NOT b.rescheduled`;
    case 'credited':
      return Prisma.sql`NOT ${owed} AND b.paid = 0 AND NOT b.rescheduled`;
    case 'rescheduled':
      return Prisma.sql`NOT ${owed} AND b.rescheduled`;
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
      rescheduled: boolean;
      due_on: Date;
    }[]
  >`
    SELECT i.id, i.total, ${CREDITED_SQL} AS credited, ${PAID_SQL} AS paid,
           ${RESCHEDULED_SQL} AS rescheduled, i.due_on
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
          rescheduled: r.rescheduled,
          dueOn: fromDate(r.due_on),
        },
      ];
    }),
  );
}
