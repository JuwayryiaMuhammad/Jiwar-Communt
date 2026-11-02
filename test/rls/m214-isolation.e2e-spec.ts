import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { daysLater, dbDate, day } from '../setup/compound-clock';
import { createAccountRow, createTenant } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  staffId: string;
  buildingId: string;
  unitId: string;
  areaId: string;
}

interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

const suffix = () => newId().slice(-8);

/** A ready, attached image of the compound's: its id. */
async function fileRow(
  tx: TenantTxClient,
  tenantId: string,
  purpose: 'site_map' | 'floor_plan',
) {
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose,
      contentType: 'image/png',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}

/**
 * The tables of the spaces (ADR 0084): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table. A compound
 * gets its calendar row when it is made, so its row is the one read.
 */
const TABLES: Table[] = [
  {
    table: 'holiday_calendars',
    key: 'tenant_id',
    linked: false,
    // Made with the compound: found, not inserted (a second is refused).
    insert: (tx, own) =>
      tx.holidayCalendar
        .upsert({
          where: { tenantId: own.tenantId },
          create: { tenantId: own.tenantId },
          update: {},
        })
        .then(() => own.tenantId),
  },
  {
    table: 'compound_holidays',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.compoundHoliday.create({
        data: {
          id,
          tenantId: own.tenantId,
          day: dbDate(day(100 + (parseInt(suffix(), 16) % 200))),
          nameEn: 'Feast',
          nameAr: 'عيد',
        },
      });
      return id;
    },
  },
  {
    table: 'site_maps',
    key: 'tenant_id',
    // Its one foreign key is to its own image, made here with it.
    linked: false,
    insert: async (tx, own) => {
      await tx.siteMap.create({
        data: {
          tenantId: own.tenantId,
          fileId: await fileRow(tx, own.tenantId, 'site_map'),
        },
      });
      return own.tenantId;
    },
  },
  {
    table: 'site_map_points',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.siteMapPoint.create({
        data: {
          id,
          tenantId: own.tenantId,
          kind: 'building',
          buildingId: link.buildingId,
          x: 0.5,
          y: 0.5,
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'floor_plans',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.floorPlan.create({
        data: {
          id,
          tenantId: own.tenantId,
          buildingId: link.buildingId,
          floor: parseInt(suffix(), 16) % 100,
          fileId: await fileRow(tx, own.tenantId, 'floor_plan'),
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'floor_plan_units',
    key: 'unit_id',
    insert: async (tx, own, link) => {
      const planId = newId();
      await tx.floorPlan.create({
        data: {
          id: planId,
          tenantId: own.tenantId,
          buildingId: own.buildingId,
          floor: 150 + (parseInt(suffix(), 16) % 50),
          fileId: await fileRow(tx, own.tenantId, 'floor_plan'),
          createdAt: new Date(),
        },
      });
      await tx.floorPlanUnit.create({
        data: {
          tenantId: own.tenantId,
          planId,
          unitId: link.unitId,
          x: 0,
          y: 0,
          width: 0.5,
          height: 0.5,
        },
      });
      return link.unitId;
    },
  },
  {
    table: 'space_use_areas',
    key: 'common_area_id',
    insert: async (tx, own, link) => {
      await tx.spaceUseArea.create({
        data: {
          tenantId: own.tenantId,
          commonAreaId: link.areaId,
          openedAt: new Date(),
        },
      });
      return link.areaId;
    },
  },
  {
    table: 'space_use_requests',
    insert: async (tx, own, link) => {
      const id = newId();
      const startsAt = daysLater(3);
      await tx.spaceUseRequest.create({
        data: {
          id,
          tenantId: own.tenantId,
          commonAreaId: link.areaId,
          unitId: link.unitId,
          requestedById: link.staffId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          purpose: 'A party',
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — spaces (ADR 0084)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Spaces ${label}`);
    const staff = await createAccountRow(h, tenantId, 'staff');
    return inTenant({ tenantId }, async (tx) => {
      const buildingId = newId();
      await tx.building.create({
        data: { id: buildingId, tenantId, name: `B-${suffix()}` },
      });
      const unitId = newId();
      await tx.unit.create({
        data: {
          id: unitId,
          tenantId,
          code: `U-${suffix()}`,
          buildingId,
          floor: 1,
        },
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
      return { tenantId, staffId: staff.id, buildingId, unitId, areaId };
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
      .filter((m) => m >= '20270420090000' && m < '20270421')
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
          /foreign key|violates|row-level security/i,
        );
      });
    }
  });
});
