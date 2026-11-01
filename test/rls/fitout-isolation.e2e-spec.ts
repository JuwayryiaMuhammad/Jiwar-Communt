import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  areaPhotoRow,
  areaRecordRow,
  commonAreaRow,
  debrisSlotRow,
  drawingRow,
} from '../setup/fitout-rows';
import { permitRow } from '../setup/permits-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  /** A works permit of the unit. */
  permitId: string;
  commonAreaId: string;
  /** A record of the area before the permit's works. */
  areaRecordId: string;
}

/**
 * One table of the fit-out: how to insert a row in a compound. `link`
 * points the row's foreign keys at another compound's rows, which the
 * composite keys must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

/**
 * The tables of fit-out completion (ADR 0074): isolated like every other
 * tenant table, linked with composite keys. The RLS coverage test checks
 * the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'permit_drawings',
    insert: (tx, own, link) =>
      drawingRow(tx, {
        tenantId: own.tenantId,
        permitId: link.permitId,
        addedBy: link.accountId,
      }),
  },
  {
    table: 'permit_debris_slots',
    insert: (tx, own, link) =>
      debrisSlotRow(tx, {
        tenantId: own.tenantId,
        permitId: link.permitId,
        scheduledBy: link.accountId,
      }),
  },
  {
    table: 'permit_area_records',
    // One per area and stage: `after`, on the seed's `before`.
    insert: (tx, own, link) =>
      areaRecordRow(tx, {
        tenantId: own.tenantId,
        permitId: link.permitId,
        commonAreaId: link.commonAreaId,
        recordedBy: link.accountId,
        phase: 'after',
      }),
  },
  {
    table: 'permit_area_photos',
    insert: (tx, own, link) =>
      areaPhotoRow(tx, { tenantId: own.tenantId, recordId: link.areaRecordId }),
  },
];

describe('RLS isolation — fit-out completion (ADR 0074)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Fit-out ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      permitId: '',
      commonAreaId: '',
      areaRecordId: '',
    };
    await inTenant(s, async (tx) => {
      s.permitId = await permitRow(tx, {
        tenantId,
        unitId: s.unitId,
        requestedById: s.accountId,
      });
      s.commonAreaId = await commonAreaRow(tx, tenantId);
      s.areaRecordId = await areaRecordRow(tx, {
        tenantId,
        permitId: s.permitId,
        commonAreaId: s.commonAreaId,
        recordedBy: s.accountId,
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

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270209090000' && m < '20270210')
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
              /permission denied|insufficient_privilege|never goes|once/.test(
                e.message,
              )
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
