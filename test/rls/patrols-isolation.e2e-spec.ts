import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import {
  checkpointRow,
  notePhotoRow,
  noteRow,
  routeRow,
  routeStopRow,
  runRow,
  scanRow,
  versionRow,
} from '../setup/patrol-rows';
import { dutyFileRow, gateRow } from '../setup/security-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  gateId: string;
  checkpointId: string;
  /** A checkpoint on no route yet: a stop may be added for it. */
  spareCheckpointId: string;
  routeId: string;
  versionId: string;
  runId: string;
  scanId: string;
  noteId: string;
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

let runs = 0;

/**
 * The patrol tables (ADR 0052): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'patrol_checkpoints',
    insert: (tx, own, link) =>
      checkpointRow(tx, {
        tenantId: own.tenantId,
        gateId: link.gateId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'patrol_routes',
    insert: async (tx, own, link) =>
      (
        await routeRow(tx, {
          tenantId: own.tenantId,
          gateId: link.gateId,
          createdById: link.accountId,
          checkpointIds: [],
        })
      ).routeId,
  },
  {
    table: 'patrol_route_versions',
    insert: (tx, own, link) =>
      versionRow(tx, {
        tenantId: own.tenantId,
        routeId: link.routeId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'patrol_route_checkpoints',
    insert: (tx, own, link) =>
      routeStopRow(tx, {
        tenantId: own.tenantId,
        versionId: link.versionId,
        checkpointId: link.spareCheckpointId,
      }),
  },
  {
    table: 'patrol_runs',
    insert: (tx, own, link) =>
      runRow(tx, {
        tenantId: own.tenantId,
        routeId: link.routeId,
        versionId: link.versionId,
        gateId: link.gateId,
        // A start of its own each time: a version makes each run once.
        inHours: 24 + ++runs,
      }),
  },
  {
    table: 'patrol_scans',
    // A run scans a checkpoint once: each of A's own on another run.
    insert: async (tx, own, link) =>
      scanRow(tx, {
        tenantId: own.tenantId,
        runId: await runRow(tx, {
          tenantId: own.tenantId,
          routeId: link.routeId,
          versionId: link.versionId,
          gateId: link.gateId,
          inHours: 500 + ++runs,
        }),
        checkpointId: link.checkpointId,
        guardId: link.accountId,
      }),
  },
  {
    table: 'patrol_notes',
    insert: async (tx, own, link) =>
      noteRow(tx, {
        tenantId: own.tenantId,
        runId: link.runId,
        scanId: await scanRow(tx, {
          tenantId: own.tenantId,
          runId: await runRow(tx, {
            tenantId: own.tenantId,
            routeId: link.routeId,
            versionId: link.versionId,
            gateId: link.gateId,
            inHours: 900 + ++runs,
          }),
          checkpointId: link.checkpointId,
          guardId: link.accountId,
        }),
        guardId: link.accountId,
      }),
  },
  {
    table: 'patrol_note_photos',
    insert: async (tx, own, link) =>
      notePhotoRow(tx, {
        tenantId: own.tenantId,
        noteId: link.noteId,
        fileId: await dutyFileRow(tx, own.tenantId, 'patrol_photo'),
        uploadedById: link.accountId,
      }),
  },
];

describe('RLS isolation — patrol tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Patrols ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      gateId: '',
      checkpointId: '',
      spareCheckpointId: '',
      routeId: '',
      versionId: '',
      runId: '',
      scanId: '',
      noteId: '',
    };
    await inTenant(s, async (tx) => {
      s.gateId = await gateRow(tx, tenantId);
      const checkpoint = () =>
        checkpointRow(tx, {
          tenantId,
          gateId: s.gateId,
          createdById: s.accountId,
        });
      s.checkpointId = await checkpoint();
      s.spareCheckpointId = await checkpoint();
      const route = await routeRow(tx, {
        tenantId,
        gateId: s.gateId,
        createdById: s.accountId,
        checkpointIds: [s.checkpointId],
      });
      s.routeId = route.routeId;
      s.versionId = route.versionId;
      s.runId = await runRow(tx, {
        tenantId,
        routeId: s.routeId,
        versionId: s.versionId,
        gateId: s.gateId,
        inHours: 2,
      });
      s.scanId = await scanRow(tx, {
        tenantId,
        runId: s.runId,
        checkpointId: s.checkpointId,
        guardId: s.accountId,
      });
      s.noteId = await noteRow(tx, {
        tenantId,
        runId: s.runId,
        scanId: s.scanId,
        guardId: s.accountId,
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
