import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  bookingRow,
  facilityRow,
  facilityWindowRow,
  slotLockRow,
} from '../setup/facilities-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  facilityId: string;
}

/**
 * One facilities table: how to insert a row in a compound. `link` points
 * the row's foreign keys at another compound's rows, which the composite
 * keys must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** The column the row is found by (`id` unless the table has none). */
  key?: string;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

/**
 * The facilities tables (ADR 0044): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'facilities',
    linked: false,
    insert: (tx, own) => facilityRow(tx, own.tenantId),
  },
  {
    table: 'facility_hours',
    insert: (tx, own, link) =>
      facilityWindowRow(tx, {
        tenantId: own.tenantId,
        facilityId: link.facilityId,
      }),
  },
  {
    table: 'facility_peak_windows',
    insert: (tx, own, link) =>
      facilityWindowRow(tx, {
        tenantId: own.tenantId,
        facilityId: link.facilityId,
        peak: true,
      }),
  },
  {
    table: 'facility_slot_locks',
    key: 'facility_id',
    insert: async (tx, own, link) =>
      own === link
        ? slotLockRow(tx, {
            tenantId: own.tenantId,
            facilityId: await facilityRow(tx, own.tenantId),
          })
        : slotLockRow(tx, {
            tenantId: own.tenantId,
            facilityId: link.facilityId,
          }),
  },
  {
    table: 'bookings',
    insert: (tx, own, link) =>
      bookingRow(tx, {
        tenantId: own.tenantId,
        facilityId: link.facilityId,
        unitId: link.unitId,
        bookedById: link.accountId,
      }),
  },
];

describe('RLS isolation — facilities tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Facilities ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      facilityId: '',
    };
    await inTenant(s, async (tx) => {
      s.facilityId = await facilityRow(tx, tenantId);
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
      expect(await count(a)).toBe(1);
      expect(await count(b)).toBe(0);
      expect(await count(b, true)).toBe(0);
    });

    it('B updates and deletes nothing of A', async () => {
      // Where the app has no UPDATE or no DELETE, or a trigger keeps the
      // row as it is, that is nothing too.
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
