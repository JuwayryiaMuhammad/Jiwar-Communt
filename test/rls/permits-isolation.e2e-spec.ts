import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  permitCounterRow,
  permitFileRow,
  permitGuestRow,
  permitRow,
  permitWorkerRow,
} from '../setup/permits-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  worksId: string;
  eventId: string;
}

/**
 * One table: how to insert a row in a compound. `link` points the row's
 * foreign keys at another compound's rows, which the composite keys must
 * refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  key?: string;
  linked?: boolean;
}

/**
 * The permits tables (ADR 0049): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'permit_settings',
    // Every compound has its row from the provisioning: read it back.
    insert: (tx, own) => Promise.resolve(own.tenantId),
    key: 'tenant_id',
    linked: false,
  },
  {
    table: 'permit_counters',
    insert: (tx, own) => permitCounterRow(tx, own.tenantId),
    key: 'tenant_id',
    linked: false,
  },
  {
    table: 'unit_permits',
    insert: (tx, own, link) =>
      permitRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        requestedById: link.accountId,
      }),
  },
  {
    table: 'permit_workers',
    insert: async (tx, own, link) =>
      permitWorkerRow(tx, {
        tenantId: own.tenantId,
        permitId: link.worksId,
        addedById: own.accountId,
        photoFileId: await permitFileRow(tx, own.tenantId),
      }),
  },
  {
    table: 'permit_guests',
    insert: (tx, own, link) =>
      permitGuestRow(tx, {
        tenantId: own.tenantId,
        permitId: link.eventId,
        addedById: own.accountId,
      }),
  },
];

describe('RLS isolation — permits tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Permits ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      worksId: '',
      eventId: '',
    };
    await inTenant(s, async (tx) => {
      const base = {
        tenantId,
        unitId: s.unitId,
        requestedById: s.accountId,
      };
      s.worksId = await permitRow(tx, base);
      s.eventId = await permitRow(tx, { ...base, kind: 'event' });
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

    if (name !== 'permit_settings')
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

  it('a worker points at a works permit only, a guest at an event only', async () => {
    await expect(
      inTenant(a, async (tx) =>
        permitWorkerRow(tx, {
          tenantId: a.tenantId,
          permitId: a.eventId,
          addedById: a.accountId,
          photoFileId: await permitFileRow(tx, a.tenantId),
        }),
      ),
    ).rejects.toThrow(/permit_workers_permit_fkey/);
    await expect(
      inTenant(a, (tx) =>
        permitGuestRow(tx, {
          tenantId: a.tenantId,
          permitId: a.worksId,
          addedById: a.accountId,
        }),
      ),
    ).rejects.toThrow(/permit_guests_permit_fkey/);
  });
});
