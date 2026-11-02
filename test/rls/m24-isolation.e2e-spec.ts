import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createTenant } from '../setup/fixtures';

/** A day of its own for each brief inserted. */
let seq = 0;

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
}

/**
 * One table of M2-4: how to insert a row in a compound. None points at
 * another tenant table but its compound's own (`linked: false`); `key` is
 * the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

/**
 * The tables of the operations dashboard (ADR 0079): the brief's times,
 * the briefs and the service pressure, isolated like every other tenant
 * table. The RLS coverage test checks the policies exist; this suite
 * checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'staff_dashboard_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.staffDashboardSettings.create({
        data: { tenantId: own.tenantId, briefMinute: 480, reviewMinute: 1080 },
      });
      return own.tenantId;
    },
  },
  {
    table: 'staff_briefs',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.staffBrief.create({
        data: {
          id,
          tenantId: own.tenantId,
          kind: 'brief',
          // A day of its own per insert: the key is (tenant, day, kind).
          day: new Date(`2031-0${(seq++ % 9) + 1}-01T00:00:00Z`),
          contents: { figures: {} },
          generatedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_service_pressure',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.maintenanceServicePressure.create({
        data: { tenantId: own.tenantId, openPerTechnician: 8 },
      });
      return own.tenantId;
    },
  },
];

describe('RLS isolation — the operations dashboard (ADR 0079)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Dashboard ${label}`);
    return { tenantId };
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
      .filter((m) => m >= '20270316090000' && m < '20270317')
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
              /permission denied/.test(e.message) ? 0 : Promise.reject(e),
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
