import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  managerId: string;
  unitId: string;
  caseId: string;
}

/**
 * One table of experience and recovery: how to insert a row in a compound.
 * `link` points the row's foreign keys at another compound's rows, which the
 * composite keys must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

let numbers = 100;

/**
 * The tables of experience and recovery (ADR 0082): isolated like every
 * other tenant table, linked with composite keys. The RLS coverage test
 * checks the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'experience_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.experienceSetting.create({ data: { tenantId: own.tenantId } });
      return own.tenantId;
    },
  },
  {
    table: 'experience_counters',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.experienceCounter.create({
        data: { tenantId: own.tenantId, last: 1 },
      });
      return own.tenantId;
    },
  },
  {
    table: 'experience_cases',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.experienceCase.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: numbers++,
          unitId: link.unitId,
          kind: 'recovery',
          origin: 'manual',
          openedById: link.managerId,
          openedAt: new Date(),
          status: 'closed',
          closedById: link.managerId,
          closedAt: new Date(),
          outcome: 'resolved',
        },
      });
      return id;
    },
  },
  {
    table: 'experience_signals',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.experienceSignal.create({
        data: {
          id,
          tenantId: own.tenantId,
          unitId: link.unitId,
          code: 'repeated_low_ratings',
          basisId: newId(),
          count: 2,
          windowDays: 90,
          detectedAt: new Date(),
          caseId: link.caseId,
        },
      });
      return id;
    },
  },
  {
    table: 'experience_compensation_rules',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.experienceCompensationRule.create({
        data: {
          tenantId: own.tenantId,
          failureCode: 'other',
          kind: 'apology',
        },
      });
      return own.tenantId;
    },
  },
  {
    table: 'experience_compensations',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.experienceCompensation.create({
        data: {
          id,
          tenantId: own.tenantId,
          caseId: link.caseId,
          unitId: link.unitId,
          kind: 'apology',
          failureCode: 'other',
          proposedById: link.managerId,
          proposedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'service_promises',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.servicePromise.create({
        data: {
          id,
          tenantId: own.tenantId,
          titleEn: 'Promise',
          titleAr: 'وعد',
          createdById: link.managerId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — experience and recovery (ADR 0082)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Experience ${label}`);
    const manager = await createAccountRow(h, tenantId, 'manager');
    const unitId = (await createUnit(h, tenantId)).id;
    const caseId = await inTenant({ tenantId }, async (tx) => {
      const id = newId();
      await tx.experienceCase.create({
        data: {
          id,
          tenantId,
          number: 1,
          unitId,
          kind: 'recovery',
          origin: 'manual',
          openedById: manager.id,
          openedAt: new Date(),
        },
      });
      return id;
    });
    return { tenantId, managerId: manager.id, unitId, caseId };
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
      .filter((m) => m >= '20270406090000' && m < '20270407')
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
