import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { daysLater, dbDate } from '../setup/compound-clock';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  staffId: string;
  /** One of the compound's seeded categories. */
  categoryId: string;
  ticketId: string;
  areaId: string;
  typeId: string;
  assetId: string;
  templateId: string;
  /** The template's item, at version 1. */
  itemId: string;
  /** An open run on the ticket. */
  runId: string;
  answerId: string;
  planId: string;
  inspectionId: string;
}

/**
 * One assets table: how to insert a row in a compound. `link` points the
 * row's foreign keys at another compound's rows, which the composite keys
 * must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

let numbers = 1000;
/**
 * Rows of A made beforehand, for "acting as B": the insert under test then
 * writes only its own table's row, so its own policy is what refuses it.
 */
let forging = false;
const spare = {
  files: {} as Record<string, string>,
  runs: [] as string[],
  inspections: [] as string[],
  tickets: [] as string[],
};
const suffix = () => newId().slice(-8);

async function ticket(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.ticket.create({
    data: {
      id,
      tenantId: own.tenantId,
      number: numbers++,
      unitId: link.unitId,
      categoryId: link.categoryId,
      createdById: link.staffId,
      reporterId: link.staffId,
      priority: 'normal',
      description: 'Fixture',
    },
  });
  return id;
}

/** A ready file of the row's own compound, attached to nothing yet. */
async function file(
  tx: TenantTxClient,
  tenantId: string,
  purpose: 'asset_document' | 'checklist_photo' | 'data_import',
) {
  if (forging) return spare.files[purpose];
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose,
      contentType: purpose === 'data_import' ? 'text/csv' : 'image/jpeg',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}

async function area(tx: TenantTxClient, own: Side): Promise<string> {
  const id = newId();
  await tx.commonArea.create({
    data: {
      id,
      tenantId: own.tenantId,
      kind: 'area',
      code: `AR-${suffix()}`,
      nameAr: 'حديقة',
      nameEn: 'Garden',
    },
  });
  return id;
}

async function assetType(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.assetType.create({
    data: {
      id,
      tenantId: own.tenantId,
      key: `t_${suffix()}`,
      nameAr: 'نوع',
      nameEn: 'Type',
      categoryId: link.categoryId,
    },
  });
  return id;
}

async function asset(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.asset.create({
    data: {
      id,
      tenantId: own.tenantId,
      code: `AS-${suffix()}`,
      typeId: link.typeId,
      depth: 1,
      commonAreaId: link.areaId,
      nameAr: 'مضخة',
      nameEn: 'Pump',
    },
  });
  return id;
}

async function template(tx: TenantTxClient, own: Side): Promise<string> {
  const id = newId();
  await tx.checklistTemplate.create({
    data: {
      id,
      tenantId: own.tenantId,
      key: `c_${suffix()}`,
      nameAr: 'قائمة',
      nameEn: 'Checklist',
      purpose: 'any',
    },
  });
  return id;
}

async function item(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.checklistTemplateItem.create({
    data: {
      id,
      tenantId: own.tenantId,
      templateId: link.templateId,
      version: 1,
      position: 1 + (numbers++ % 99),
      kind: 'check',
      labelAr: 'افحص',
      labelEn: 'Check',
    },
  });
  return id;
}

async function run(tx: TenantTxClient, own: Side, link: Side): Promise<string> {
  const id = newId();
  await tx.checklistRun.create({
    data: {
      id,
      tenantId: own.tenantId,
      templateId: link.templateId,
      version: 1,
      ticketId: link.ticketId,
      cycle: numbers++,
      assetId: link.assetId,
      createdAt: new Date(),
    },
  });
  return id;
}

async function answer(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.checklistAnswer.create({
    data: {
      id,
      tenantId: own.tenantId,
      // A run of its own (one answer per run and item).
      runId:
        own !== link
          ? link.runId
          : forging
            ? spare.runs.shift()!
            : await run(tx, own, own),
      itemId: link.itemId,
      result: 'pass',
      answeredById: link.staffId,
      answeredAt: new Date(),
    },
  });
  return id;
}

async function plan(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.maintenancePlan.create({
    data: {
      id,
      tenantId: own.tenantId,
      assetId: link.assetId,
      checklistId: link.templateId,
      title: 'Service',
      categoryId: link.categoryId,
      trigger: 'calendar',
      every: 3,
      unit: 'month',
      anchorOn: dbDate('2031-01-10'),
      basis: 'fixed',
      nextDueOn: dbDate('2031-04-10'),
      ownerId: link.staffId,
    },
  });
  return id;
}

async function inspection(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.inspection.create({
    data: {
      id,
      tenantId: own.tenantId,
      checklistId: link.templateId,
      assetId: link.assetId,
      assigneeId: link.staffId,
      originalDueOn: dbDate('2031-01-10'),
      dueOn: dbDate('2031-01-10'),
      createdAt: new Date(),
    },
  });
  return id;
}

/**
 * The assets tables (ADR 0064): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'common_areas',
    linked: false,
    insert: (tx, own) => area(tx, own),
  },
  { table: 'asset_types', insert: assetType },
  { table: 'assets', insert: asset },
  {
    table: 'asset_events',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.assetEvent.create({
        data: {
          id,
          tenantId: own.tenantId,
          assetId: link.assetId,
          kind: 'created',
          actorId: link.staffId,
          occurredAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_documents',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.maintenanceDocument.create({
        data: {
          id,
          tenantId: own.tenantId,
          assetId: link.assetId,
          fileId: await file(tx, own.tenantId, 'asset_document'),
          kind: 'manual',
          title: 'Manual',
          addedById: link.staffId,
          addedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'asset_imports',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.assetImport.create({
        data: {
          id,
          tenantId: own.tenantId,
          fileId: await file(tx, own.tenantId, 'data_import'),
          status: 'valid',
          rowCount: 1,
          errorCount: 0,
          createdById: link.staffId,
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'checklist_templates',
    linked: false,
    insert: (tx, own) => template(tx, own),
  },
  { table: 'checklist_template_items', insert: item },
  { table: 'checklist_runs', insert: run },
  { table: 'checklist_answers', insert: answer },
  {
    table: 'checklist_answer_photos',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.checklistAnswerPhoto.create({
        data: {
          id,
          tenantId: own.tenantId,
          answerId: link.answerId,
          fileId: await file(tx, own.tenantId, 'checklist_photo'),
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'asset_readings',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.assetReading.create({
        data: {
          id,
          tenantId: own.tenantId,
          assetId: link.assetId,
          metricKey: 'pressure',
          value: '2.5',
          source: 'manual',
          recordedById: link.staffId,
          occurredAt: daysLater(-1),
          recordedAt: new Date(),
        },
      });
      return id;
    },
  },
  { table: 'maintenance_plans', insert: plan },
  {
    table: 'maintenance_plan_occurrences',
    insert: async (tx, own, link) => {
      const id = newId();
      const on = `2031-${String(1 + (numbers++ % 12)).padStart(2, '0')}-10`;
      await tx.maintenancePlanOccurrence.create({
        data: {
          id,
          tenantId: own.tenantId,
          planId: link.planId,
          originalDueOn: dbDate(on),
          dueOn: dbDate(on),
          status: 'skipped',
          reasonCode: 'not_needed',
          generatedAt: new Date(),
          closedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_plan_events',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.maintenancePlanEvent.create({
        data: {
          id,
          tenantId: own.tenantId,
          planId: link.planId,
          kind: 'created',
          actorId: link.staffId,
          occurredAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'inspection_rounds',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.inspectionRound.create({
        data: {
          id,
          tenantId: own.tenantId,
          title: 'Round',
          checklistId: link.templateId,
          commonAreaId: link.areaId,
          assigneeId: link.staffId,
          every: 1,
          unit: 'week',
          anchorOn: dbDate('2031-01-06'),
          nextDueOn: dbDate('2031-01-13'),
        },
      });
      return id;
    },
  },
  { table: 'inspections', insert: inspection },
  {
    table: 'inspection_findings',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.inspectionFinding.create({
        data: {
          id,
          tenantId: own.tenantId,
          // An inspection of its own (one finding per inspection and item).
          inspectionId:
            own !== link
              ? link.inspectionId
              : forging
                ? spare.inspections.shift()!
                : await inspection(tx, own, own),
          itemId: link.itemId,
          ticketId:
            own !== link
              ? link.ticketId
              : forging
                ? spare.tickets.shift()!
                : await ticket(tx, own, own),
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'field_scans',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.fieldScan.create({
        data: {
          id,
          tenantId: own.tenantId,
          assetId: link.assetId,
          accountId: link.staffId,
          scannedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'asset_replacement_recommendations',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.assetReplacementRecommendation.create({
        data: {
          id,
          tenantId: own.tenantId,
          assetId: link.assetId,
          reasonCode: 'end_of_life',
          recommendedById: link.staffId,
          recommendedAt: new Date(),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — assets, checklists, plans and inspections (ADR 0064)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Assets ${label}`);
    const unit = await createUnit(h, tenantId);
    const staff = await createAccountRow(h, tenantId, 'staff');
    const category = await inTenant({ tenantId }, (tx) =>
      tx.ticketCategory.findFirstOrThrow({ where: { key: 'plumbing' } }),
    );
    const s = {
      tenantId,
      unitId: unit.id,
      staffId: staff.id,
      categoryId: category.id,
    } as Side;
    await inTenant(s, async (tx) => {
      s.ticketId = await ticket(tx, s, s);
      s.areaId = await area(tx, s);
      s.typeId = await assetType(tx, s, s);
      s.assetId = await asset(tx, s, s);
      s.templateId = await template(tx, s);
      s.itemId = await item(tx, s, s);
      s.runId = await run(tx, s, s);
      s.answerId = await answer(tx, s, s);
      s.planId = await plan(tx, s, s);
      s.inspectionId = await inspection(tx, s, s);
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
      for (const purpose of [
        'asset_document',
        'data_import',
        'checklist_photo',
      ] as const)
        spare.files[purpose] = await file(tx, a.tenantId, purpose);
      spare.runs.push(await run(tx, a, a));
      spare.inspections.push(await inspection(tx, a, a));
      spare.tickets.push(await ticket(tx, a, a));
    });
  });

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20261201090000' && m < '20261202')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ].map((x) => x[1]),
      );
    expect(TABLES.map((t) => t.table).sort()).toEqual(created.sort());
    expect(created.sort()).toEqual(
      [
        'common_areas',
        'asset_types',
        'assets',
        'asset_events',
        'maintenance_documents',
        'asset_imports',
        'checklist_templates',
        'checklist_template_items',
        'checklist_runs',
        'checklist_answers',
        'checklist_answer_photos',
        'asset_readings',
        'maintenance_plans',
        'maintenance_plan_occurrences',
        'maintenance_plan_events',
        'inspection_rounds',
        'inspections',
        'inspection_findings',
        'field_scans',
        'asset_replacement_recommendations',
      ].sort(),
    );
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
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE id = $1::uuid`,
        ),
      ).toBe(0);
      expect(await exec(`DELETE FROM "${name}" WHERE id = $1::uuid`)).toBe(0);
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
