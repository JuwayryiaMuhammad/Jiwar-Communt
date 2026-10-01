import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
}

/**
 * One new Phase 4 tenant table: how to insert a row in a compound. `link`
 * points the row's foreign keys at another compound's rows, which the
 * composite keys must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** Column used to address the row (default `id`). */
  key?: string;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

/**
 * Phase 4 tenant tables (ADR 0027, 0028): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'notifications',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.notification.create({
        data: {
          id,
          tenantId: own.tenantId,
          accountId: link.accountId,
          kind: 'worker.entered',
          priority: 'normal',
          params: { unitCode: 'X' },
        },
      });
      return id;
    },
  },
  {
    table: 'idempotency_keys',
    key: 'resource_id',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.idempotencyKey.create({
        data: {
          tenantId: own.tenantId,
          accountId: link.accountId,
          key: `key-${id}`,
          requestHash: 'x',
          route: '/probe',
          resourceType: 'probe',
          resourceId: id,
          responseStatus: 201,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — Phase 4 tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Gate ${label}`);
    const unit = await createUnit(h, tenantId);
    const account = await createAccountRow(h, tenantId, 'resident');
    return { tenantId, unitId: unit.id, accountId: account.id };
  };

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    a = await side('A');
    b = await side('B');
    for (const t of TABLES)
      ids[t.table] = await inTenant(a, (tx) => t.insert(tx, a, a));
  });

  afterAll(() => h.close());

  describe.each(TABLES.map((t) => [t.table, t] as const))('%s', (name, t) => {
    const key = t.key ?? 'id';

    it('A sees its row; B does not, by id or in a full scan', async () => {
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
      const changed = await inTenant(b, async (tx) => {
        const updated = await tx.$executeRawUnsafe(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::uuid`,
          ids[name],
        );
        return updated;
      });
      expect(changed).toBe(0);
      const deleted = await inTenant(b, (tx) =>
        tx
          .$executeRawUnsafe(
            `DELETE FROM "${name}" WHERE "${key}" = $1::uuid`,
            ids[name],
          )
          .catch((e: Error) =>
            /permission denied/.test(e.message) ? 0 : Promise.reject(e),
          ),
      );
      expect(deleted).toBe(0);
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
