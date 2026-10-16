import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import {
  dutyFileRow,
  gateRow,
  handoverItemRow,
  handoverRow,
  shiftRow,
  slotRow,
  taskPhotoRow,
  taskRow,
  templateRow,
} from '../setup/security-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  gateId: string;
  shiftId: string;
  taskId: string;
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

let slots = 0;

/**
 * The guard shifts and tasks tables (ADR 0050): isolated like every other
 * tenant table, linked with composite keys. The RLS coverage test checks
 * the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'guard_roster_templates',
    insert: (tx, own, link) =>
      templateRow(tx, {
        tenantId: own.tenantId,
        guardId: link.accountId,
        gateId: link.gateId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'guard_roster_slots',
    insert: (tx, own, link) =>
      slotRow(tx, {
        tenantId: own.tenantId,
        guardId: link.accountId,
        gateId: link.gateId,
        createdById: link.accountId,
        // A slot of its own each time: a guard's slots never overlap.
        inHours: 24 + 2 * ++slots,
      }),
  },
  {
    table: 'guard_handover_items',
    insert: (tx, own) => handoverItemRow(tx, own.tenantId),
    linked: false,
  },
  {
    table: 'guard_handovers',
    insert: async (tx, own, link) =>
      handoverRow(tx, {
        tenantId: own.tenantId,
        // A shift of its own each time: one handover per shift.
        shiftId:
          own === link
            ? await shiftRow(tx, {
                tenantId: own.tenantId,
                guardId: own.accountId,
                gateId: own.gateId,
              })
            : link.shiftId,
        guardId: link.accountId,
        gateId: link.gateId,
      }),
  },
  {
    table: 'guard_tasks',
    insert: (tx, own, link) =>
      taskRow(tx, {
        tenantId: own.tenantId,
        gateId: link.gateId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'guard_task_photos',
    insert: async (tx, own, link) =>
      taskPhotoRow(tx, {
        tenantId: own.tenantId,
        taskId: link.taskId,
        // A file of its own each time: a photo belongs to one task.
        fileId: await dutyFileRow(tx, own.tenantId),
        uploadedById: link.accountId,
      }),
  },
];

describe('RLS isolation — guard shifts and tasks tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Guard duty ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      gateId: '',
      shiftId: '',
      taskId: '',
    };
    await inTenant(s, async (tx) => {
      s.gateId = await gateRow(tx, tenantId);
      s.shiftId = await shiftRow(tx, {
        tenantId,
        guardId: s.accountId,
        gateId: s.gateId,
      });
      s.taskId = await taskRow(tx, {
        tenantId,
        gateId: s.gateId,
        createdById: s.accountId,
      });
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
