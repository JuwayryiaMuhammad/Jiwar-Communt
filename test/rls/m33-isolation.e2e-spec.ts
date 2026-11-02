import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  staffId: string;
  assetId: string;
  scheduleId: string;
  planId: string;
}

interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

const suffix = () => newId().slice(-8);

/**
 * The reports platform's tables (ADR 0086): isolated like every other
 * tenant table, linked with composite keys. The RLS coverage test checks
 * the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'report_schedules',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.reportSchedule.create({
        data: {
          id,
          tenantId: own.tenantId,
          reportKey: 'maintenance_spend',
          cadence: 'daily',
          format: 'csv',
          createdById: link.staffId,
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    // An expired run: no file to seed.
    table: 'report_runs',
    insert: async (tx, own, link) => {
      const id = newId();
      const written = new Date();
      await tx.reportRun.create({
        data: {
          id,
          tenantId: own.tenantId,
          scheduleId: link.scheduleId,
          reportKey: 'maintenance_spend',
          periodFrom: new Date(
            `2026-0${1 + (Number.parseInt(suffix(), 16) % 9)}-01`,
          ),
          periodTo: new Date('2026-12-31'),
          format: 'csv',
          rows: 0,
          status: 'expired',
          writtenAt: written,
          expiresAt: new Date(written.getTime() + 60_000),
          expiredAt: written,
        },
      });
      return id;
    },
  },
  {
    table: 'capital_plans',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.capitalPlan.create({
        data: {
          id,
          tenantId: own.tenantId,
          year: 2030 + (Number.parseInt(suffix(), 16) % 60),
          createdById: link.staffId,
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    // Its own compound's draft plan; the asset is what may come from another.
    table: 'capital_plan_lines',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.capitalPlanLine.create({
        data: {
          id,
          tenantId: own.tenantId,
          planId: own.planId,
          assetId: link.assetId,
          description: 'Replace the pump',
          amount: '100.00',
          source: 'manual',
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'compound_exports',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.compoundExport.create({
        data: {
          id,
          tenantId: own.tenantId,
          requestedByAccountId: link.staffId,
          requestedAt: new Date(),
          status: 'failed',
          endedAt: new Date(),
          failureCode: 'build_failed',
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — the reports platform (ADR 0086)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Reports ${label}`);
    const staff = await createAccountRow(h, tenantId, 'staff');
    return inTenant({ tenantId }, async (tx) => {
      const category = await tx.ticketCategory.findFirstOrThrow({
        where: { key: 'plumbing' },
      });
      const areaId = newId();
      await tx.commonArea.create({
        data: {
          id: areaId,
          tenantId,
          kind: 'area',
          code: `AR-${suffix()}`,
          nameAr: 'حديقة',
          nameEn: 'Garden',
        },
      });
      const typeId = newId();
      await tx.assetType.create({
        data: {
          id: typeId,
          tenantId,
          key: `t_${suffix()}`,
          nameAr: 'نوع',
          nameEn: 'Type',
          categoryId: category.id,
        },
      });
      const assetId = newId();
      await tx.asset.create({
        data: {
          id: assetId,
          tenantId,
          code: `AS-${suffix()}`,
          typeId,
          depth: 1,
          commonAreaId: areaId,
          nameAr: 'مضخة',
          nameEn: 'Pump',
        },
      });
      const scheduleId = newId();
      await tx.reportSchedule.create({
        data: {
          id: scheduleId,
          tenantId,
          reportKey: 'energy_cost',
          cadence: 'monthly',
          format: 'pdf',
          createdById: staff.id,
          createdAt: new Date(),
        },
      });
      const planId = newId();
      await tx.capitalPlan.create({
        data: {
          id: planId,
          tenantId,
          year: 2029,
          createdById: staff.id,
          createdAt: new Date(),
        },
      });
      return { tenantId, staffId: staff.id, assetId, scheduleId, planId };
    });
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
      .filter((m) => m >= '20270504090000' && m < '20270505')
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
            `SELECT count(*) AS n FROM "${name}" WHERE ${all ? `tenant_id = $1::uuid` : `id = $1::uuid`}`,
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
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE id = $1::uuid`,
        ),
      ).toBe(0);
      expect(await run(`DELETE FROM "${name}" WHERE id = $1::uuid`)).toBe(0);
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
