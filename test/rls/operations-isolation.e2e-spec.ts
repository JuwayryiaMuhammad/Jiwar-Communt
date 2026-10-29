import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { dbDate } from '../setup/compound-clock';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  staffId: string;
  categoryId: string;
  ticketId: string;
  areaId: string;
  assetId: string;
  storeId: string;
  itemId: string;
  requestId: string;
  movementId: string;
  quoteId: string;
  contractId: string;
}

/**
 * One operations table: how to insert a row in a compound. `link` points
 * the row's foreign keys at another compound's rows, which the composite
 * keys must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  linked?: boolean;
}

let numbers = 5000;
const suffix = () => newId().slice(-8);
/** Rows of A made beforehand for "acting as B" (see the assets suite). */
let forging = false;
const spare = { assets: [] as string[] };

async function ticket(tx: TenantTxClient, own: Side, link: Side) {
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

async function store(tx: TenantTxClient, own: Side) {
  const id = newId();
  await tx.store.create({
    data: {
      id,
      tenantId: own.tenantId,
      code: `ST-${suffix()}`,
      nameAr: 'مخزن',
      nameEn: 'Store',
    },
  });
  return id;
}

async function item(tx: TenantTxClient, own: Side) {
  const id = newId();
  await tx.stockItem.create({
    data: {
      id,
      tenantId: own.tenantId,
      sku: `SKU-${suffix()}`,
      nameAr: 'قطعة',
      nameEn: 'Part',
      unit: 'piece',
    },
  });
  return id;
}

async function request(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.partRequest.create({
    data: {
      id,
      tenantId: own.tenantId,
      ticketId: link.ticketId,
      itemId: link.itemId,
      quantity: '1',
      requestedById: link.staffId,
      requestedAt: new Date(),
    },
  });
  return id;
}

async function movement(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.stockMovement.create({
    data: {
      id,
      tenantId: own.tenantId,
      itemId: link.itemId,
      storeId: link.storeId,
      kind: 'receive',
      quantity: '1',
      unitCost: '1',
      actorId: link.staffId,
      occurredAt: new Date(),
    },
  });
  return id;
}

async function quote(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.ticketQuote.create({
    data: {
      id,
      tenantId: own.tenantId,
      ticketId: link.ticketId,
      amount: '10',
      proposedById: link.staffId,
    },
  });
  return id;
}

async function contract(tx: TenantTxClient, own: Side) {
  const id = newId();
  await tx.maintenanceContract.create({
    data: {
      id,
      tenantId: own.tenantId,
      code: `C-${suffix()}`,
      kind: 'amc',
      vendorName: 'Vendor',
      startsOn: dbDate('2031-01-01'),
      endsOn: dbDate('2031-12-31'),
    },
  });
  return id;
}

async function asset(tx: TenantTxClient, own: Side) {
  const type = await tx.assetType.findFirstOrThrow({ where: { key: 'pump' } });
  const id = newId();
  await tx.asset.create({
    data: {
      id,
      tenantId: own.tenantId,
      code: `AS-${suffix()}`,
      typeId: type.id,
      depth: 1,
      commonAreaId: own.areaId,
      nameAr: 'مضخة',
      nameEn: 'Pump',
    },
  });
  return id;
}

/**
 * The maintenance operations tables (ADR 0065): isolated like every other
 * tenant table, linked with composite keys. The RLS coverage test checks
 * the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'ticket_cost_entries',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketCostEntry.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          kind: 'labour',
          description: 'Hours',
          quantity: '1',
          unitAmount: '10',
          amount: '10.00',
          enteredById: link.staffId,
          enteredAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'ticket_completions',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketCompletion.create({
        data: {
          id,
          tenantId: own.tenantId,
          ticketId: link.ticketId,
          cycle: 1,
          actionCode: 'repaired',
          technicianId: link.staffId,
          completedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'ticket_quote_suggestions',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ticketQuoteSuggestion.create({
        data: {
          id,
          tenantId: own.tenantId,
          // A ticket of its own: one waits per ticket.
          ticketId:
            own === link && !forging
              ? await ticket(tx, own, own)
              : link.ticketId,
          amount: '50',
          suggestedById: link.staffId,
          suggestedAt: new Date(),
        },
      });
      return id;
    },
  },
  { table: 'stores', linked: false, insert: (tx, own) => store(tx, own) },
  { table: 'stock_items', linked: false, insert: (tx, own) => item(tx, own) },
  {
    table: 'stock_levels',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.stockLevel.create({
        data: {
          id,
          tenantId: own.tenantId,
          storeId: link.storeId,
          // A store and item pair of its own: one level each.
          itemId: own === link && !forging ? await item(tx, own) : link.itemId,
        },
      });
      return id;
    },
  },
  { table: 'part_requests', insert: request },
  { table: 'stock_movements', insert: movement },
  {
    table: 'maintenance_contracts',
    linked: false,
    insert: (tx, own) => contract(tx, own),
  },
  {
    table: 'maintenance_contract_assets',
    key: 'asset_id',
    insert: async (tx, own, link) => {
      const assetId =
        own !== link
          ? link.assetId
          : forging
            ? spare.assets.shift()!
            : await asset(tx, own);
      await tx.maintenanceContractAsset.create({
        data: {
          tenantId: own.tenantId,
          contractId: link.contractId,
          assetId,
          addedById: link.staffId,
          addedAt: new Date(),
        },
      });
      return assetId;
    },
  },
];

describe('RLS isolation — maintenance operations (ADR 0065)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Operations ${label}`);
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
      s.areaId = newId();
      await tx.commonArea.create({
        data: {
          id: s.areaId,
          tenantId,
          kind: 'area',
          code: `AR-${suffix()}`,
          nameAr: 'غرفة',
          nameEn: 'Room',
        },
      });
      s.assetId = await asset(tx, s);
      s.storeId = await store(tx, s);
      s.itemId = await item(tx, s);
      s.requestId = await request(tx, s, s);
      s.movementId = await movement(tx, s, s);
      s.quoteId = await quote(tx, s, s);
      s.contractId = await contract(tx, s);
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
      spare.assets.push(await asset(tx, a));
    });
  });

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20261208090000' && m < '20261209')
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
