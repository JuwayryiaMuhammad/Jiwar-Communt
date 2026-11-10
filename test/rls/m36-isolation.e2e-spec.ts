import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { day, dbDate } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { required } from '../setup/test-env';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  staffId: string;
  vendorId: string;
  cashAccountId: string;
  payoutId: string;
}

interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

let n = 0;
const next = () => ++n;
const year = (k: number) => `${1900 + k}-01-01`;

/**
 * Taxes' and the year-end close's tables (ADR 0093): isolated like every
 * other tenant table, linked with composite keys.
 */
const TABLES: Table[] = [
  {
    table: 'finance_vat_declarations',
    insert: async (tx, own, link) => {
      const id = newId();
      // Nothing to set off: no entry posts.
      await tx.financeVatDeclaration.create({
        data: {
          id,
          tenantId: own.tenantId,
          month: dbDate(year(next())),
          taxableSales: '0',
          outputVat: '0',
          taxablePurchases: '0',
          inputVat: '0',
          carriedIn: '0',
          netDue: '0',
          carriedOut: '0',
          declaredByAccountId: link.staffId,
          declaredAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'finance_tax_payments',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeTaxPayment.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: 900_000 + next(),
          kind: 'withholding',
          quarter: dbDate('2026-01-01'),
          amount: '5.00',
          paidOn: dbDate(day(0)),
          method: 'bank_transfer',
          cashAccountId: own.cashAccountId,
          paidByAccountId: link.staffId,
          createdAt: new Date(),
        },
      });
      await tx.financeCashMovement.create({
        data: {
          id: newId(),
          tenantId: own.tenantId,
          accountId: own.cashAccountId,
          kind: 'tax_payment',
          amount: '-5.00',
          onDay: dbDate(day(0)),
          taxPaymentId: id,
          recordedById: own.staffId,
        },
      });
      return id;
    },
  },
  {
    table: 'finance_withholding_certificates',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeWithholdingCertificate.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: 900_000 + next(),
          payoutId: own.payoutId,
          vendorId: link.vendorId,
          category: 'services',
          rate: '3.00',
          base: '100.00',
          amount: '3.00',
          paidOn: dbDate(day(0)),
        },
      });
      // One a payout: the next row of the compound's needs its own.
      own.payoutId = await payoutRow(own);
      return id;
    },
  },
  {
    table: 'gl_year_closes',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.glYearClose.create({
        data: {
          id,
          tenantId: own.tenantId,
          startsOn: dbDate(year(next())),
          endsOn: dbDate(`${1900 + n}-12-31`),
          revenue: '0',
          expenses: '0',
          result: '0',
          closedByAccountId: link.staffId,
          closedAt: new Date(),
        },
      });
      return id;
    },
  },
];

/**
 * TEST-ONLY: a payout row with nothing behind it, for a certificate to
 * name (replica skips the triggers, the foreign keys' with them).
 */
async function payoutRow(side: { tenantId: string; vendorId: string }) {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  const id = newId();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      `INSERT INTO finance_vendor_payouts
         (id, tenant_id, number, kind, vendor_invoice_id, expense_id, vendor_id, gross, net,
          method, paid_on, paid_by_account_id, cash_account_id, created_at)
       VALUES ($1, $2, $3, 'invoice', gen_random_uuid(), gen_random_uuid(), $4, 100, 100,
               'cash', CURRENT_DATE, gen_random_uuid(), gen_random_uuid(), now())`,
      [id, side.tenantId, 900_000 + next(), side.vendorId],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
  return id;
}

describe('RLS isolation — taxes and the year-end close (ADR 0093)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Taxes ${label}`);
    const staff = await createAccountRow(h, tenantId, 'staff');
    await createUnit(h, tenantId);
    const vendorId = newId();
    const cashAccountId = newId();
    await inTenant({ tenantId }, async (tx) => {
      await tx.vendor.create({
        data: {
          id: vendorId,
          tenantId,
          number: next(),
          name: `Vendor ${label}`,
        },
      });
      await tx.financeCashAccount.create({
        data: {
          id: cashAccountId,
          tenantId,
          kind: 'bank',
          name: `Bank ${label}`,
          openedOn: dbDate(day(0)),
          createdById: staff.id,
        },
      });
    });
    return {
      tenantId,
      staffId: staff.id,
      vendorId,
      cashAccountId,
      payoutId: await payoutRow({ tenantId, vendorId }),
    };
  };

  beforeAll(async () => {
    h = await createDbHarness();
    a = await side('A');
    b = await side('B');
    for (const t of TABLES)
      ids[t.table] = await inTenant(a, (tx) => t.insert(tx, a, a));
  }, 60_000);

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270617090000' && m < '20270618')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ].map((x) => x[1]),
      );
    expect(TABLES.map((t) => t.table).sort()).toEqual(created.sort());
  });

  describe.each(TABLES.map((t) => [t.table, t] as const))('%s', (name, t) => {
    const key = t.key ?? 'id';

    it('A sees its row; B does not, by its key or in a full scan', async () => {
      const count = (s: Side, all = false) =>
        inTenant(s, async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${name}" WHERE ${all ? `tenant_id = $1::uuid` : `"${key}" = $1::uuid`}`,
            all ? a.tenantId : ids[name],
          );
          return Number(rows[0].n);
        });
      expect(await count(a)).toBe(1);
      expect(await count(b)).toBe(0);
      expect(await count(b, true)).toBe(0);
    });

    it('B updates and deletes nothing of A', async () => {
      const run = (sql: string) =>
        inTenant(b, (tx) =>
          tx
            .$executeRawUnsafe(sql, ids[name])
            .catch((e: Error) =>
              /permission denied|immutable|insufficient/i.test(e.message)
                ? 0
                : Promise.reject(e),
            ),
        );
      expect(
        await run(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::uuid`,
        ),
      ).toBe(0);
      expect(await run(`DELETE FROM "${name}" WHERE "${key}" = $1::uuid`)).toBe(
        0,
      );
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      await expect(inTenant(b, (tx) => t.insert(tx, a, a))).rejects.toThrow(
        /row-level security|violates/,
      );
    });

    it('a row may not point at another compound’s rows (composite keys)', async () => {
      await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
        /foreign key|violates/i,
      );
    });
  });
});
