import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { daysLater } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  staffId: string;
  assetId: string;
  categoryId: string;
  buildingId: string;
  ticketId: string;
  caseId: string;
}

/**
 * One table of the maintenance analytics: how to insert a row in a compound. `link`
 * points the row's foreign keys at another compound's rows, which the
 * composite keys must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

const suffix = () => newId().slice(-8);

/**
 * The tables of dispatch depth (ADR 0076): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
/**
 * The tables of the maintenance analytics (ADR 0081): isolated like every
 * other tenant table, linked with composite keys (a case's building has
 * none, by design; its category has). The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'ticket_sensitive_reads',
    // No foreign keys, like the history tables.
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.ticketSensitiveRead.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: own.ticketId,
          accountId: own.staffId,
          via: 'detail',
          readAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_plan_suggestions',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.maintenancePlanSuggestion.create({
        data: {
          id,
          tenantId: own.tenantId,
          assetId: link.assetId,
          categoryId: link.categoryId,
          ticketCount: 3,
          windowDays: 90,
          firstTicketAt: daysLater(-1),
          lastTicketAt: new Date(),
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_cases',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.maintenanceCase.create({
        data: {
          id,
          tenantId: own.tenantId,
          categoryId: link.categoryId,
          // A fresh building id each time: one open case a category and building.
          buildingId: newId(),
          openedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'maintenance_case_tickets',
    key: 'ticket_id',
    insert: async (tx, own, link) => {
      await tx.maintenanceCaseTicket.create({
        data: {
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          caseId: link.caseId,
          linkedAt: new Date(),
        },
      });
      return link.ticketId;
    },
  },
];

describe('RLS isolation — maintenance analytics (ADR 0081)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Analytics ${label}`);
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
      const buildingId = newId();
      await tx.building.create({
        data: { id: buildingId, tenantId, name: `Tower ${suffix()}` },
      });
      const ticketId = newId();
      await tx.ticket.create({
        data: {
          id: ticketId,
          tenantId,
          number: 1,
          commonArea: 'Lobby',
          categoryId: category.id,
          createdById: staff.id,
          reporterId: staff.id,
          priority: 'normal',
          description: 'Isolation fixture',
        },
      });
      // A case to link tickets to (one per side; the table's own row is another).
      const caseId = newId();
      await tx.maintenanceCase.create({
        data: {
          id: caseId,
          tenantId,
          categoryId: category.id,
          buildingId,
          openedAt: new Date(),
        },
      });
      return {
        tenantId,
        staffId: staff.id,
        assetId,
        categoryId: category.id,
        buildingId,
        ticketId,
        caseId,
      };
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
      .filter((m) => m >= '20270330090000' && m < '20270331')
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
