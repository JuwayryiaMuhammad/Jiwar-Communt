import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { addDays } from '../../src/maintenance/schedules/local-dates';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { dbDate } from '../setup/compound-clock';
import { facilityRow } from '../setup/facilities-rows';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  staffId: string;
  residentId: string;
  categoryId: string;
  checklistId: string;
  programId: string;
  campaignItemId: string;
  areaId: string;
  inspectionId: string;
  facilityId: string;
  ticketId: string;
  instructionId: string;
}

/**
 * One M1-3b table: how to insert a row in a compound. `link` points the
 * row's foreign keys at another compound's rows, which the composite keys
 * must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  linked?: boolean;
}

const suffix = () => newId().slice(-8);
/** Each row its own day, version, cycle and number: no unique key in the way. */
let days = 0;
const nextDay = () => dbDate(addDays('2031-01-01', days++));
let counter = 1;
const next = () => counter++;
/** Rows of A made beforehand for "acting as B". */
let forging = false;
const spare = {
  areas: [] as string[],
  inspections: [] as string[],
  facilities: [] as string[],
};

async function program(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.readinessProgram.create({
    data: {
      id,
      tenantId: own.tenantId,
      kind: 'season',
      title: 'Summer',
      startsOn: nextDay(),
      endsOn: dbDate('2031-12-31'),
      // A copy points at its source: B's, to try the composite key.
      copiedFromId: own === link ? null : link.programId,
    },
  });
  return id;
}

async function item(
  tx: TenantTxClient,
  own: Side,
  link: Side,
  campaign = false,
) {
  const id = newId();
  await tx.readinessItem.create({
    data: {
      id,
      tenantId: own.tenantId,
      programId: link.programId,
      kind: campaign ? 'inspection_campaign' : 'task',
      title: 'Pumps',
      ownerId: link.staffId,
      dueOn: dbDate('2031-06-01'),
      checklistId: campaign ? link.checklistId : null,
    },
  });
  return id;
}

async function area(tx: TenantTxClient, own: Side) {
  if (forging) return spare.areas.shift()!;
  const id = newId();
  await tx.commonArea.create({
    data: {
      id,
      tenantId: own.tenantId,
      kind: 'area',
      code: `AR-${suffix()}`,
      nameAr: 'غرفة',
      nameEn: 'Room',
    },
  });
  return id;
}

async function inspection(tx: TenantTxClient, own: Side, areaId: string) {
  if (forging) return spare.inspections.shift()!;
  const id = newId();
  await tx.inspection.create({
    data: {
      id,
      tenantId: own.tenantId,
      checklistId: own.checklistId,
      commonAreaId: areaId,
      assigneeId: own.staffId,
      originalDueOn: dbDate('2031-06-01'),
      dueOn: dbDate('2031-06-01'),
      createdAt: new Date(),
    },
  });
  return id;
}

/**
 * The tables of readiness, facility bans and field safety (ADR 0067):
 * isolated like every other tenant table, linked with composite keys. The
 * RLS coverage test checks the policies exist; this suite checks they
 * hold, table by table.
 */
const TABLES: Table[] = [
  { table: 'readiness_programs', insert: program },
  { table: 'readiness_items', insert: (tx, own, link) => item(tx, own, link) },
  {
    table: 'readiness_campaign_inspections',
    insert: async (tx, own, link) => {
      // A target and an inspection of its own each time, or the other's.
      const areaId = own === link ? await area(tx, own) : link.areaId;
      const inspectionId =
        own === link ? await inspection(tx, own, areaId) : link.inspectionId;
      const id = newId();
      await tx.readinessCampaignInspection.create({
        data: {
          id,
          tenantId: own.tenantId,
          itemId: link.campaignItemId,
          inspectionId,
          commonAreaId: areaId,
        },
      });
      return id;
    },
  },
  {
    table: 'facility_bans',
    insert: async (tx, own, link) => {
      // A facility of its own each time: one ban not lifted per scope.
      const facilityId =
        own !== link
          ? link.facilityId
          : forging
            ? spare.facilities.shift()!
            : await facilityRow(tx, own.tenantId);
      const id = newId();
      await tx.facilityBan.create({
        data: {
          id,
          tenantId: own.tenantId,
          accountId: link.residentId,
          facilityId,
          reasonCode: 'damage',
        },
      });
      return id;
    },
  },
  {
    table: 'work_permits',
    insert: async (tx, own, link) => {
      const id = newId();
      const at = new Date();
      // Rejected: not open, so the one-open key is never in the way.
      await tx.workPermit.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          cycle: 1,
          hazard: 'height',
          precautions: 'Harness',
          requestedAt: at,
          expiresAt: new Date(at.getTime() + 3_600_000),
          requestedById: link.staffId,
          status: 'rejected',
          decidedAt: at,
          decidedById: link.staffId,
          rejectReason: 'other',
        },
      });
      return id;
    },
  },
  {
    table: 'safety_instructions',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.safetyInstruction.create({
        data: {
          id,
          tenantId: own.tenantId,
          categoryId: link.categoryId,
          version: next(),
          textEn: 'Gloves',
          textAr: 'قفازات',
        },
      });
      return id;
    },
  },
  {
    table: 'safety_acknowledgements',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.safetyAcknowledgement.create({
        data: {
          id,
          tenantId: own.tenantId,
          instructionId: link.instructionId,
          accountId: link.staffId,
          ticketId: link.ticketId,
          cycle: next(),
          contentSha256: 'a'.repeat(64),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — readiness, facility bans and field safety (ADR 0067)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Readiness ${label}`);
    const unit = await createUnit(h, tenantId);
    const staff = await createAccountRow(h, tenantId, 'staff');
    const resident = await createAccountRow(h, tenantId, 'resident');
    const s = {
      tenantId,
      unitId: unit.id,
      staffId: staff.id,
      residentId: resident.id,
    } as Side;
    await inTenant(s, async (tx) => {
      s.categoryId = (
        await tx.ticketCategory.findFirstOrThrow({ where: { key: 'plumbing' } })
      ).id;
      s.checklistId = newId();
      await tx.checklistTemplate.create({
        data: {
          id: s.checklistId,
          tenantId,
          key: `c_${suffix()}`,
          nameAr: 'قائمة',
          nameEn: 'Checklist',
          purpose: 'any',
        },
      });
      s.programId = await program(tx, s, s);
      s.campaignItemId = await item(tx, s, s, true);
      s.areaId = await area(tx, s);
      s.inspectionId = await inspection(tx, s, s.areaId);
      s.facilityId = await facilityRow(tx, tenantId);
      s.ticketId = newId();
      await tx.ticket.create({
        data: {
          id: s.ticketId,
          tenantId,
          number: next(),
          unitId: s.unitId,
          categoryId: s.categoryId,
          createdById: s.staffId,
          reporterId: s.staffId,
          priority: 'normal',
          description: 'Fixture',
        },
      });
      s.instructionId = newId();
      await tx.safetyInstruction.create({
        data: {
          id: s.instructionId,
          tenantId,
          categoryId: s.categoryId,
          version: next(),
          textEn: 'Gloves',
          textAr: 'قفازات',
        },
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
    await inTenant(a, async (tx) => {
      const areaId = await area(tx, a);
      spare.areas.push(areaId);
      spare.inspections.push(await inspection(tx, a, areaId));
      spare.facilities.push(await facilityRow(tx, a.tenantId));
    });
  });

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20261222090000' && m < '20261223')
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
      const exec = (sql: string) =>
        inTenant(b, (tx) =>
          tx
            .$executeRawUnsafe(sql, ids[name])
            .catch((e: Error) =>
              /permission denied/.test(e.message) ? 0 : Promise.reject(e),
            ),
        );
      expect(
        await exec(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::uuid`,
        ),
      ).toBe(0);
      expect(
        await exec(`DELETE FROM "${name}" WHERE "${key}" = $1::uuid`),
      ).toBe(0);
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      forging = true;
      try {
        await expect(inTenant(b, (tx) => t.insert(tx, a, a))).rejects.toThrow(
          new RegExp(`row-level security policy for table "${name}"`),
        );
      } finally {
        forging = false;
      }
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
