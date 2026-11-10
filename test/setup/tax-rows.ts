import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { day } from './compound-clock';
import { required } from './test-env';

/**
 * Raw rows of taxes (ADR 0093) for the API suites (the foreign ids, the
 * no-store calls): written over the superuser connection with
 * `session_replication_role = replica`, so nothing behind them is needed
 * and nothing posts (TEST-ONLY).
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
const number = () => 950_000 + (Date.now() % 40_000) + ++n;

/** A withholding certificate of a payout nothing else stands behind, today: its id. */
export function withholdingCertificateRow(r: {
  tenantId: string;
  vendorId: string;
  amount?: string;
}): Promise<string> {
  return asSuperuser(async (db) => {
    const payoutId = newId();
    const id = newId();
    await db.query(
      `INSERT INTO finance_vendor_payouts
         (id, tenant_id, number, kind, vendor_invoice_id, expense_id, vendor_id, gross,
          withholding, withholding_rate, withholding_base, withholding_category, net,
          method, paid_on, paid_by_account_id, cash_account_id, created_at)
       VALUES ($1, $2, $3, 'invoice', gen_random_uuid(), gen_random_uuid(), $4, 1000,
               $5, 3, 1000, 'services', 1000 - $5::numeric,
               'bank_transfer', $6::date, gen_random_uuid(), gen_random_uuid(), now())`,
      [payoutId, r.tenantId, number(), r.vendorId, r.amount ?? '30.00', day(0)],
    );
    await db.query(
      `INSERT INTO finance_withholding_certificates
         (id, tenant_id, number, payout_id, vendor_id, category, rate, base, amount, paid_on)
       VALUES ($1, $2, $3, $4, $5, 'services', 3, 1000, $6, $7::date)`,
      [
        id,
        r.tenantId,
        number(),
        payoutId,
        r.vendorId,
        r.amount ?? '30.00',
        day(0),
      ],
    );
    return id;
  });
}

/** A month's VAT declared with nothing due (its first day): its id. */
export function vatDeclarationRow(r: {
  tenantId: string;
  declaredById: string;
  month: string;
}): Promise<string> {
  return asSuperuser(async (db) => {
    const id = newId();
    await db.query(
      `INSERT INTO finance_vat_declarations
         (id, tenant_id, month, taxable_sales, output_vat, taxable_purchases, input_vat,
          carried_in, net_due, carried_out, declared_by_account_id, declared_at)
       VALUES ($1, $2, $3::date, 0, 0, 0, 0, 0, 0, 0, $4, now())`,
      [id, r.tenantId, r.month, r.declaredById],
    );
    return id;
  });
}
