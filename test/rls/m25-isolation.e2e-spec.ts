import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { dbClock, dbDate } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { marketFileRow } from '../setup/market-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  vendorId: string;
  contractId: string;
}

interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  linked?: boolean;
}

let numbers = 1000;
const day = dbDate('2027-01-01');
const later = dbDate('2027-12-31');

async function vendorRow(tx: TenantTxClient, tenantId: string) {
  const id = newId();
  await tx.vendor.create({
    data: { id, tenantId, number: ++numbers, name: `Isolated ${id}` },
  });
  return id;
}

async function contractRow(
  tx: TenantTxClient,
  input: { tenantId: string; vendorId: string },
) {
  const id = newId();
  await tx.maintenanceContract.create({
    data: {
      id,
      tenantId: input.tenantId,
      code: `ISO-${++numbers}`,
      kind: 'amc',
      vendorId: input.vendorId,
      vendorName: 'Isolated',
      startsOn: day,
      endsOn: later,
    },
  });
  return id;
}

/**
 * The tables of ADR 0077: isolated like every other tenant table, linked
 * with composite keys. The RLS coverage test checks the policies exist;
 * this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'procurement_counters',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.procurementCounter.create({
        data: { tenantId: own.tenantId, kind: 'purchase_request' },
      });
      return own.tenantId;
    },
  },
  {
    table: 'vendors',
    linked: false,
    insert: (tx, own) => vendorRow(tx, own.tenantId),
  },
  {
    table: 'vendor_documents',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.vendorDocument.create({
        data: {
          id,
          tenantId: own.tenantId,
          vendorId: link.vendorId,
          kind: 'licence',
          fileId: await marketFileRow(tx, own.tenantId, 'vendor_document'),
          addedById: link.accountId,
          addedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'vendor_evaluations',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.vendorEvaluation.create({
        data: {
          id,
          tenantId: own.tenantId,
          vendorId: link.vendorId,
          contractId: link.contractId,
          quality: 3,
          timeliness: 3,
          cost: 3,
          communication: 3,
          safety: 3,
          evaluatedById: link.accountId,
          evaluatedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_contract_payments',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.maintenanceContractPayment.create({
        data: {
          id,
          tenantId: own.tenantId,
          contractId: link.contractId,
          dueOn: dbDate(
            `2027-02-${String((numbers++ % 27) + 1).padStart(2, '0')}`,
          ),
          amount: '10',
          createdById: link.accountId,
          createdAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'purchase_requests',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.purchaseRequest.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: ++numbers,
          title: 'An isolated request',
          vendorId: link.vendorId,
          estimatedAmount: '10',
          requestedById: link.accountId,
          requestedAt: dbClock(),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — vendors, contracts and purchase requests (ADR 0077)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Procurement ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      vendorId: '',
      contractId: '',
    };
    await inTenant(s, async (tx) => {
      s.vendorId = await vendorRow(tx, tenantId);
      s.contractId = await contractRow(tx, { tenantId, vendorId: s.vendorId });
    });
    return s;
  };

  beforeAll(async () => {
    h = await createDbHarness();
    a = await side('A');
    b = await side('B');
    for (const t of TABLES)
      ids[t.table] = await inTenant(a, (tx) => t.insert(tx, a, a));
  });

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270302090000' && m < '20270303')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ].map((x) => x[1]),
      );
    expect(TABLES.map((t) => t.table).sort()).toEqual(created.sort());
  });

  it('a contract may not name another compound’s vendor', async () => {
    await expect(
      inTenant(a, (tx) =>
        contractRow(tx, { tenantId: a.tenantId, vendorId: b.vendorId }),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
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
              /permission denied|immutable|keeps|never|moves forward|paid once/.test(
                e.message,
              )
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
        /row-level security/,
      );
    });

    if (t.linked !== false) {
      it('a row may not point at another compound’s rows (composite keys)', async () => {
        await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
          /foreign key|violates/i,
        );
      });
    }
  });
});
