import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { unitRow } from '../setup/children-rows';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  staffId: string;
  residentId: string;
  unitId: string;
  entryId: string;
}

/**
 * One table of transfers, dues and closed units: how to insert a row in a
 * compound. `link` points the row's foreign keys at another compound's
 * rows, which the composite keys must refuse; `key` is the column it is
 * found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

let numbers = 0;

/** An emergency entry of the unit, recorded by the staff account. */
async function entryRow(
  tx: TenantTxClient,
  own: { tenantId: string },
  link: { unitId: string; staffId: string },
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.unitEntry.create({
    data: {
      id,
      tenantId: own.tenantId,
      number: 1000 + ++numbers,
      unitId: link.unitId,
      reasonCode: 'water_leak',
      enteredAt: now,
      recordedBy: link.staffId,
      recordedAt: now,
    },
  });
  return id;
}

/** A file of an entry's photo, attached. */
async function photoFile(tx: TenantTxClient, tenantId: string) {
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose: 'unit_entry_photo',
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
 * The tables of transfers, dues and closed units (ADR 0083): isolated like
 * every other tenant table, linked with composite keys. The RLS coverage
 * test checks the policies exist; this suite checks they hold.
 */
const TABLES: Table[] = [
  {
    table: 'ownership_transfers',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.ownershipTransfer.create({
        data: {
          id,
          tenantId: own.tenantId,
          number: 1000 + ++numbers,
          // A unit of its own each time: one pending a unit.
          unitId: link === own ? await unitRow(tx, own.tenantId) : link.unitId,
          buyerId: link.residentId,
          resides: true,
          reasonCode: 'unit_changed_hands',
          reasonText: 'Sold.',
          requestedBy: link.staffId,
          requestedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'closed_unit_rounds',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.closedUnitRound.create({
        data: {
          id,
          tenantId: own.tenantId,
          // A unit of its own each time: one live round a unit.
          unitId: link === own ? await unitRow(tx, own.tenantId) : link.unitId,
          dueOn: new Date('2027-05-01T00:00:00Z'),
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'unit_entries',
    insert: (tx, own, link) => entryRow(tx, own, link),
  },
  {
    table: 'unit_entry_witnesses',
    key: 'entry_id',
    insert: async (tx, own, link) => {
      // An entry of its own each time: a witness once an entry.
      const entryId =
        link === own ? await entryRow(tx, own, own) : link.entryId;
      await tx.unitEntryWitness.create({
        data: { tenantId: own.tenantId, entryId, accountId: link.staffId },
      });
      return entryId;
    },
  },
  {
    table: 'unit_entry_photos',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.unitEntryPhoto.create({
        data: {
          id,
          tenantId: own.tenantId,
          entryId: link.entryId,
          fileId: await photoFile(tx, own.tenantId),
          stage: 'before',
          uploadedBy: link.staffId,
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — transfers, dues and closed units (ADR 0083)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Transfers ${label}`);
    const staff = await createAccountRow(h, tenantId, 'staff');
    const resident = await createAccountRow(h, tenantId, 'resident');
    return inTenant({ tenantId }, async (tx) => {
      const unitId = await unitRow(tx, tenantId);
      const entryId = await entryRow(
        tx,
        { tenantId },
        { unitId, staffId: staff.id },
      );
      return {
        tenantId,
        staffId: staff.id,
        residentId: resident.id,
        unitId,
        entryId,
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
      .filter((m) => m >= '20270413090000' && m < '20270414')
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

    it('a row may not point at another compound’s rows (composite keys)', async () => {
      await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
        /foreign key|violates/i,
      );
    });
  });
});
