import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  /** A second staff account: the seed row's caller (one live call each). */
  spareId: string;
}

interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

/** A technician's call, open; the requester is `link`'s account. */
const helpRow = async (tx: TenantTxClient, own: Side, link: Side) => {
  const id = newId();
  await tx.technicianHelpRequest.create({
    data: {
      id,
      tenantId: own.tenantId,
      requesterId: link.accountId,
      kind: 'extra_hands',
    },
  });
  return id;
};

/**
 * The tables of the field team (ADR 0078): isolated like every other
 * tenant table, linked with composite keys.
 */
const TABLES: Table[] = [
  {
    table: 'technician_help_requests',
    // One live call a requester: the seed row is the spare account's.
    insert: (tx, own, link) =>
      helpRow(tx, own, {
        ...link,
        accountId: own === link ? own.spareId : link.accountId,
      }),
  },
];

describe('RLS isolation — the field team (ADR 0078)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Field team ${label}`);
    return {
      tenantId,
      accountId: (await createAccountRow(h, tenantId, 'staff')).id,
      spareId: (await createAccountRow(h, tenantId, 'staff')).id,
    };
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
      .filter((m) => m >= '20270309090000' && m < '20270310')
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
    it('A sees its row; B does not, by its id or in a full scan', async () => {
      const count = (s: Side, all = false) =>
        inTenant(s, async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${name}" WHERE ${all ? `tenant_id = $1::uuid` : `"id" = $1::uuid`}`,
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
              /permission denied/.test(e.message) ? 0 : Promise.reject(e),
            ),
        );
      expect(
        await run(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "id" = $1::uuid`,
        ),
      ).toBe(0);
      expect(await run(`DELETE FROM "${name}" WHERE "id" = $1::uuid`)).toBe(0);
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      await expect(inTenant(b, (tx) => t.insert(tx, a, a))).rejects.toThrow(
        /row-level security/,
      );
    });

    it('a row may not point at another compound’s rows (composite keys)', async () => {
      await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
        /foreign key|violates/i,
      );
    });
  });
});
