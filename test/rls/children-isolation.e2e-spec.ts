import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import {
  controlRow,
  escortRow,
  minorRow,
  pickupRow,
  unitRow,
} from '../setup/children-rows';
import { gateRow, shiftRow } from '../setup/security-rows';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  unitId: string;
  /** A live control of one of its minors. */
  controlId: string;
  gateId: string;
  shiftId: string;
  /** Minors with no control yet, one taken per insert that links here. */
  spareMinors: string[];
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
 * The children's tables (ADR 0054): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'child_controls',
    insert: async (tx, own, link) =>
      controlRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        memberId:
          own === link
            ? await minorRow(tx, {
                tenantId: own.tenantId,
                unitId: own.unitId,
                addedById: own.accountId,
              })
            : link.spareMinors.pop()!,
        turnedOnById: link.accountId,
      }),
  },
  {
    table: 'child_escorts',
    insert: (tx, own, link) =>
      escortRow(tx, {
        tenantId: own.tenantId,
        controlId: link.controlId,
        unitId: link.unitId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'child_pickups',
    insert: (tx, own, link) =>
      pickupRow(tx, {
        tenantId: own.tenantId,
        controlId: link.controlId,
        unitId: link.unitId,
        guardId: link.accountId,
        shiftId: link.shiftId,
        gateId: link.gateId,
      }),
  },
];

describe('RLS isolation — children tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Children ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      unitId: '',
      controlId: '',
      gateId: '',
      shiftId: '',
      spareMinors: [],
    };
    await inTenant(s, async (tx) => {
      s.unitId = await unitRow(tx, tenantId);
      s.gateId = await gateRow(tx, tenantId);
      s.shiftId = await shiftRow(tx, {
        tenantId,
        guardId: s.accountId,
        gateId: s.gateId,
      });
      s.controlId = await controlRow(tx, {
        tenantId,
        unitId: s.unitId,
        memberId: await minorRow(tx, {
          tenantId,
          unitId: s.unitId,
          addedById: s.accountId,
        }),
        turnedOnById: s.accountId,
      });
      for (let i = 0; i < 4; i++)
        s.spareMinors.push(
          await minorRow(tx, {
            tenantId,
            unitId: s.unitId,
            addedById: s.accountId,
          }),
        );
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
