import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { day, dbDate } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { glAccountId } from '../setup/gl-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  staffId: string;
  unitId: string;
  /** Two postable accounts no register keeps. */
  suspenseId: string;
  openingId: string;
}

/** One table of the ledger: how to insert a row in a compound. */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

let n = 0;
const next = () => ++n;

/** An entry of `own`'s with two lines on `link`'s accounts: its id and its first line's. */
async function entryRow(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<{ entryId: string; lineId: string }> {
  const entryId = newId();
  const lineId = newId();
  await tx.$executeRaw`
    INSERT INTO gl_entries (id, tenant_id, posted_on, event_on, source, source_id)
    VALUES (${entryId}::uuid, ${own.tenantId}::uuid, ${day(0)}::date, ${day(0)}::date,
            'manual', ${newId()}::uuid)`;
  await tx.$executeRaw`
    INSERT INTO gl_lines (id, tenant_id, entry_id, line_no, account_id, debit, credit, posted_on, entry_seq)
    VALUES (${lineId}::uuid, ${own.tenantId}::uuid, ${entryId}::uuid, 1, ${link.suspenseId}::uuid, 10, 0, ${day(0)}::date, 0),
           (gen_random_uuid(), ${own.tenantId}::uuid, ${entryId}::uuid, 2, ${link.openingId}::uuid, 0, 10, ${day(0)}::date, 0)`;
  return { entryId, lineId };
}

/** A pending manual entry of `own`'s by `link`'s staff, its lines on `own`'s accounts. */
async function manualRow(
  tx: TenantTxClient,
  own: Side,
  link: Side,
  unitId: string | null = null,
): Promise<string> {
  const id = newId();
  await tx.glManualEntry.create({
    data: {
      id,
      tenantId: own.tenantId,
      number: 800_000 + next(),
      postedOn: dbDate(day(0)),
      memo: 'Isolation',
      createdByAccountId: link.staffId,
      createdAt: new Date(),
    },
  });
  await tx.glManualEntryLine.createMany({
    data: [
      {
        tenantId: own.tenantId,
        manualEntryId: id,
        lineNo: 1,
        accountId: own.suspenseId,
        debit: '1.00',
        unitId,
      },
      {
        tenantId: own.tenantId,
        manualEntryId: id,
        lineNo: 2,
        accountId: own.openingId,
        credit: '1.00',
      },
    ],
  });
  return id;
}

/**
 * The general ledger's tables (ADR 0092): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'gl_accounts',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.glAccount.create({
        data: {
          id,
          tenantId: own.tenantId,
          code: `1900.${next()}`,
          nameEn: 'Isolated',
          nameAr: 'معزول',
          type: 'asset',
          parentId: own.suspenseId,
          createdByAccountId: link.staffId,
        },
      });
      return id;
    },
  },
  {
    table: 'gl_periods',
    key: 'closed_by_account_id',
    insert: async (tx, own, link) => {
      await tx.glPeriod.create({
        data: {
          tenantId: own.tenantId,
          month: new Date(Date.UTC(1990, next(), 1)),
          status: 'closed',
          closedAt: new Date(),
          closedByAccountId: link.staffId,
        },
      });
      return link.staffId;
    },
  },
  {
    table: 'gl_entries',
    insert: async (tx, own, link) => (await entryRow(tx, own, link)).entryId,
  },
  {
    table: 'gl_lines',
    insert: async (tx, own, link) => (await entryRow(tx, own, link)).lineId,
  },
  {
    table: 'gl_manual_entries',
    insert: (tx, own, link) => manualRow(tx, own, link),
  },
  {
    table: 'gl_manual_entry_lines',
    key: 'unit_id',
    insert: async (tx, own, link) => {
      await manualRow(tx, own, own, link.unitId);
      return link.unitId;
    },
  },
];

describe('RLS isolation — the general ledger (ADR 0092)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Ledger ${label}`);
    const staff = await createAccountRow(h, tenantId, 'staff');
    const unit = await createUnit(h, tenantId);
    return inTenant({ tenantId }, async (tx) => ({
      tenantId,
      staffId: staff.id,
      unitId: unit.id,
      suspenseId: await glAccountId(tx, tenantId, 'suspense'),
      openingId: await glAccountId(tx, tenantId, 'opening_balances'),
    }));
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
      .filter((m) => m >= '20270615090000' && m < '20270616')
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
