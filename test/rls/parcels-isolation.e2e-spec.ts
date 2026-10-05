import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  /** A parcel of the compound, for the rows that hang off one. */
  parcelId: string;
}

/**
 * One parcels table: how to insert a row in a compound. `link` points the
 * row's foreign keys at another compound's rows, which the composite keys
 * must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  key?: string;
  linked?: boolean;
}

let numbers = 1000;

/** 64 hex characters from an id (a stand-in for an HMAC). */
const hash = (id: string) =>
  (id.replace(/-/g, '') + id.replace(/-/g, '')).slice(0, 64);

async function parcel(
  tx: TenantTxClient,
  own: Side,
  link: Side,
): Promise<string> {
  const id = newId();
  await tx.parcel.create({
    data: {
      id,
      tenantId: own.tenantId,
      number: numbers++,
      unitId: link.unitId,
      gateId: newId(),
      shiftId: newId(),
      receivedById: newId(),
      carrier: 'dhl',
      pieces: 1,
    },
  });
  return id;
}

/**
 * Parcels tables (ADR 0035): isolated like every other tenant table, linked
 * with composite keys. The RLS coverage test checks the policies exist; this
 * suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  { table: 'parcels', insert: parcel },
  {
    table: 'parcel_credentials',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.parcelCredential.create({
        data: {
          id,
          tenantId: own.tenantId,
          parcelId: link.parcelId,
          kind: 'holder',
          // Live hashes are unique in a compound: one pair per row.
          codeHash: hash(id),
          qrTokenHash: hash(id.split('').reverse().join('')),
          createdById: newId(),
        },
      });
      return id;
    },
  },
  {
    // Append-only and without foreign keys, like gate_entries.
    table: 'parcel_events',
    linked: false,
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.parcelEvent.create({
        data: {
          id,
          tenantId: own.tenantId,
          parcelId: link.parcelId,
          kind: 'received',
          actorSide: 'guard',
          actorId: newId(),
        },
      });
      return id;
    },
  },
  {
    table: 'parcel_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.parcelSettings.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'parcel_counters',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.parcelCounter.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
];

describe('RLS isolation — parcels tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Parcels ${label}`);
    const unit = await createUnit(h, tenantId);
    const s: Side = { tenantId, unitId: unit.id, parcelId: '' };
    s.parcelId = await inTenant(s, (tx) => parcel(tx, s, s));
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

    it('A sees its row; B does not, by id or in a full scan', async () => {
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
      // No DELETE for the app here, and the event log refuses UPDATE too:
      // both are also nothing.
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
