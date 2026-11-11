import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { day } from './compound-clock';
import { required } from './test-env';

/**
 * Raw rows of purchase orders (ADR 0094) for the API suites (the foreign
 * ids, the no-store calls): written over the superuser connection with
 * `session_replication_role = replica`, so nothing behind them is needed
 * and nothing is kept against the budget (TEST-ONLY).
 */
async function asSuperuser<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } finally {
    await db.end();
  }
}

let n = 0;
const number = () => 960_000 + (Date.now() % 30_000) + ++n;

/**
 * An approved purchase order with one service line, its first revision and a
 * receipt of the line, sent to its vendor: the order's id, its line's and its
 * receipt's.
 */
export function purchaseOrderRow(r: {
  tenantId: string;
  vendorId: string;
  budgetLineId: string;
  raisedById: string;
}): Promise<{ orderId: string; lineId: string; receiptId: string }> {
  return asSuperuser(async (db) => {
    const orderId = newId();
    const lineId = newId();
    const receiptId = newId();
    await db.query(
      `INSERT INTO purchase_orders
         (id, tenant_id, number, vendor_id, budget_line_id, source, delivery_on,
          revision, status, subtotal, tax, total, raised_by_account_id, raised_at,
          decided_by_account_id, decided_at, sent_by_account_id, sent_at, sent_revision)
       VALUES ($1, $2, $3, $4, $5, 'direct', $6::date, 1, 'approved', 1000, 0, 1000,
               $7, now(), $7, now(), $7, now(), 1)`,
      [
        orderId,
        r.tenantId,
        number(),
        r.vendorId,
        r.budgetLineId,
        day(30),
        r.raisedById,
      ],
    );
    await db.query(
      `INSERT INTO purchase_order_lines
         (id, tenant_id, purchase_order_id, position, kind, description, quantity, unit,
          unit_price, net, tax)
       VALUES ($1, $2, $3, 1, 'service', 'Row service', 1, 'lot', 1000, 1000, 0)`,
      [lineId, r.tenantId, orderId],
    );
    await db.query(
      `INSERT INTO purchase_order_revisions
         (id, tenant_id, purchase_order_id, revision, status, budget_line_id, delivery_on,
          lines, subtotal, tax, total, requested_by_account_id, requested_at,
          decided_by_account_id, decided_at)
       VALUES ($1, $2, $3, 1, 'approved', $4, $5::date, '[]'::jsonb, 1000, 0, 1000,
               $6, now(), $6, now())`,
      [newId(), r.tenantId, orderId, r.budgetLineId, day(30), r.raisedById],
    );
    await db.query(
      `INSERT INTO goods_receipts
         (id, tenant_id, number, purchase_order_id, received_on, received_by_account_id, created_at)
       VALUES ($1, $2, $3, $4, $5::date, $6, now())`,
      [receiptId, r.tenantId, number(), orderId, day(0), r.raisedById],
    );
    await db.query(
      `INSERT INTO goods_receipt_lines
         (tenant_id, receipt_id, purchase_order_line_id, accepted, rejected)
       VALUES ($1, $2, $3, 1, 0)`,
      [r.tenantId, receiptId, lineId],
    );
    return { orderId, lineId, receiptId };
  });
}
