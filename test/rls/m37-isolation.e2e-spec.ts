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
  lineId: string;
  /** A vendor invoice naming an order (a raw row). */
  invoiceId: string;
}

interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

let n = 0;
const next = () => ++n;

/**
 * A purchase order of `own`, naming `link`'s vendor, line and staff, with
 * its one line (the lines add up to it at commit): the order's id, its
 * line's.
 */
async function order(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<{ orderId: string; lineId: string }> {
  const orderId = newId();
  const lineId = newId();
  await tx.purchaseOrder.create({
    data: {
      id: orderId,
      tenantId: own.tenantId,
      number: 800_000 + next(),
      vendorId: link.vendorId,
      budgetLineId: link.lineId,
      source: 'direct',
      deliveryOn: dbDate(day(10)),
      subtotal: '10.00',
      tax: '0.00',
      total: '10.00',
      raisedById: link.staffId,
      raisedAt: new Date(),
    },
  });
  await tx.purchaseOrderLine.create({
    data: {
      id: lineId,
      tenantId: own.tenantId,
      purchaseOrderId: orderId,
      position: 1,
      kind: 'service',
      description: 'Isolated work',
      quantity: '1',
      unit: 'lot',
      unitPrice: '10.00',
      net: '10.00',
      tax: '0.00',
    },
  });
  return { orderId, lineId };
}

/**
 * Purchase orders’, goods receipts’ and the match’s tables (ADR 0094):
 * isolated like every other tenant table, linked with composite keys.
 */
const TABLES: Table[] = [
  {
    table: 'purchase_orders',
    insert: async (tx, own, link) => (await order(tx, own, link)).orderId,
  },
  {
    table: 'purchase_order_lines',
    insert: async (tx, own, link) => (await order(tx, own, link)).lineId,
  },
  {
    table: 'purchase_order_revisions',
    insert: async (tx, own, link) => {
      const { orderId } = await order(tx, own, link);
      const id = newId();
      await tx.purchaseOrderRevision.create({
        data: {
          id,
          tenantId: own.tenantId,
          purchaseOrderId: orderId,
          revision: 1,
          budgetLineId: link.lineId,
          deliveryOn: dbDate(day(10)),
          lines: [],
          subtotal: '10.00',
          tax: '0.00',
          total: '10.00',
          requestedById: link.staffId,
          requestedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'goods_receipts',
    insert: async (tx, own, link) => {
      const { orderId } = await order(tx, own, link);
      const id = newId();
      await tx.goodsReceipt.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: 800_000 + next(),
          purchaseOrderId: orderId,
          receivedOn: dbDate(day(0)),
          receivedById: link.staffId,
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'goods_receipt_lines',
    key: 'receipt_id',
    insert: async (tx, own, link) => {
      const { orderId, lineId } = await order(tx, own, link);
      const receiptId = newId();
      await tx.goodsReceipt.create({
        data: {
          id: receiptId,
          tenantId: own.tenantId,
          number: 800_000 + next(),
          purchaseOrderId: orderId,
          receivedOn: dbDate(day(0)),
          receivedById: link.staffId,
          createdAt: new Date(),
        },
      });
      await tx.goodsReceiptLine.create({
        data: {
          tenantId: own.tenantId,
          receiptId,
          purchaseOrderLineId: lineId,
          accepted: '1.000',
        },
      });
      return receiptId;
    },
  },
  {
    table: 'goods_receipt_photos',
    insert: async (tx, own, link) => {
      const { orderId } = await order(tx, own, link);
      const receiptId = newId();
      await tx.goodsReceipt.create({
        data: {
          id: receiptId,
          tenantId: own.tenantId,
          number: 800_000 + next(),
          purchaseOrderId: orderId,
          receivedOn: dbDate(day(0)),
          receivedById: link.staffId,
          createdAt: new Date(),
        },
      });
      // The photo is a file of the side it names.
      const fileId = newId();
      const now = new Date();
      await tx.storedFile.create({
        data: {
          id: fileId,
          tenantId: link.tenantId,
          purpose: 'goods_receipt_photo',
          contentType: 'image/png',
          sizeBytes: 100,
          status: 'ready',
          uploadExpiresAt: now,
          finalizedAt: now,
          attachedAt: now,
        },
      });
      await tx.goodsReceiptPhoto.create({
        data: { tenantId: own.tenantId, receiptId, fileId },
      });
      return fileId;
    },
    key: 'file_id',
  },
  {
    table: 'finance_invoice_match_overrides',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.financeInvoiceMatchOverride.create({
        data: {
          id,
          tenantId: own.tenantId,
          invoiceId: link.invoiceId,
          reasonCode: 'rounding',
          issues: [{ kind: 'price_over', position: 1, amount: '1.00' }],
          overriddenById: link.staffId,
          overriddenAt: new Date(),
        },
      });
      return id;
    },
  },
];

/**
 * TEST-ONLY: a vendor invoice naming an order, with nothing behind it
 * (replica skips the triggers, the foreign keys’ with them), for an
 * override to name.
 */
async function invoiceRow(side: {
  tenantId: string;
  vendorId: string;
  staffId: string;
}) {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  const id = newId();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      `INSERT INTO finance_vendor_invoices
         (id, tenant_id, number, vendor_id, vendor_number, issued_on, due_on,
          purchase_order_id, invoice_file_id, subtotal, tax, total, recorded_by_account_id,
          recorded_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, CURRENT_DATE, gen_random_uuid(),
               gen_random_uuid(), 100, 0, 100, $6, now())`,
      [
        id,
        side.tenantId,
        800_000 + next(),
        side.vendorId,
        `ISO-${id}`,
        side.staffId,
      ],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
  return id;
}

describe('RLS isolation — purchase orders, goods receipts and the match (ADR 0094)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Orders ${label}`);
    const staff = await createAccountRow(h, tenantId, 'staff');
    await createUnit(h, tenantId);
    const vendorId = newId();
    const budgetId = newId();
    const lineId = newId();
    await inTenant({ tenantId }, async (tx) => {
      await tx.vendor.create({
        data: {
          id: vendorId,
          tenantId,
          number: next(),
          name: `Vendor ${label}`,
        },
      });
      await tx.financeBudget.create({
        data: {
          id: budgetId,
          tenantId,
          fiscalYear: 2027,
          startsOn: dbDate('2027-01-01'),
          endsOn: dbDate('2027-12-31'),
          createdById: staff.id,
          createdAt: new Date(),
        },
      });
      await tx.financeBudgetLine.create({
        data: {
          id: lineId,
          tenantId,
          budgetId,
          category: 'maintenance',
          amount: '1000',
        },
      });
    });
    return {
      tenantId,
      staffId: staff.id,
      vendorId,
      lineId,
      invoiceId: await invoiceRow({ tenantId, vendorId, staffId: staff.id }),
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
      .filter((m) => m >= '20270702090000' && m < '20270703')
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
      expect(await count(a)).toBeGreaterThanOrEqual(1);
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
