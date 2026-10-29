import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { addDays } from '../../src/maintenance/schedules/local-dates';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { dbDate } from '../setup/compound-clock';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  staffId: string;
  meterId: string;
  readingId: string;
  fileId: string;
  importId: string;
  outageId: string;
}

/**
 * One energy table: how to insert a row in a compound. `link` points the
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
/** Each row its own day, so no "one a day" key is ever in the way. */
let days = 0;
const nextDay = () => dbDate(addDays('2031-01-01', days++));
/** Rows of A made beforehand for "acting as B". */
let forging = false;
const spare = { files: [] as string[], outages: [] as string[] };

async function meter(tx: TenantTxClient, own: Side) {
  const id = newId();
  await tx.meter.create({
    data: {
      id,
      tenantId: own.tenantId,
      code: `M-${suffix()}`,
      kind: 'water',
      unitId: own.unitId,
    },
  });
  return id;
}

async function reading(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.meterReading.create({
    data: {
      id,
      tenantId: own.tenantId,
      meterId: link.meterId,
      readOn: nextDay(),
      value: '1',
      source: 'manual',
      recordedById: link.staffId,
    },
  });
  return id;
}

async function file(tx: TenantTxClient, tenantId: string) {
  if (forging) return spare.files.shift()!;
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose: 'data_import',
      contentType: 'text/csv',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}

async function readingImport(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.meterReadingImport.create({
    data: {
      id,
      tenantId: own.tenantId,
      // A file of its own each time (one import a file), or the other's.
      fileId: own === link ? await file(tx, own.tenantId) : link.fileId,
      status: 'valid',
      rowCount: 1,
      errorCount: 0,
      createdById: link.staffId,
      createdAt: new Date(),
    },
  });
  return id;
}

async function outage(tx: TenantTxClient, own: Side) {
  const id = newId();
  await tx.utilityOutage.create({
    data: {
      id,
      tenantId: own.tenantId,
      kind: 'water',
      planned: true,
      scope: 'compound',
      startsAt: new Date('2031-06-01T08:00:00.000Z'),
      endsAt: new Date('2031-06-01T12:00:00.000Z'),
    },
  });
  return id;
}

/**
 * The energy tables (ADR 0066): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  { table: 'meters', linked: false, insert: (tx, own) => meter(tx, own) },
  { table: 'meter_readings', insert: reading },
  {
    table: 'meter_alerts',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.meterAlert.create({
        data: {
          id,
          tenantId: own.tenantId,
          meterId: link.meterId,
          readingId: link.readingId,
          readOn: nextDay(),
          kind: 'spike',
          dailyRate: '9',
          baselineRate: '1',
        },
      });
      return id;
    },
  },
  { table: 'meter_reading_imports', insert: readingImport },
  {
    table: 'energy_tariffs',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.energyTariff.create({
        data: {
          id,
          tenantId: own.tenantId,
          kind: 'water',
          effectiveOn: nextDay(),
          pricePerUnit: '1.5',
        },
      });
      return id;
    },
  },
  {
    table: 'energy_measures',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.energyMeasure.create({
        data: {
          id,
          tenantId: own.tenantId,
          title: 'LEDs',
          kind: 'water',
          meterId: link.meterId,
          startsOn: nextDay(),
        },
      });
      return id;
    },
  },
  {
    table: 'utility_outages',
    linked: false,
    insert: (tx, own) => outage(tx, own),
  },
  {
    table: 'utility_outage_recipients',
    key: 'outage_id',
    insert: async (tx, own, link) => {
      // An outage of its own each time: one row an outage and account here.
      const outageId =
        own !== link
          ? link.outageId
          : forging
            ? spare.outages.shift()!
            : await outage(tx, own);
      await tx.utilityOutageRecipient.create({
        data: {
          tenantId: own.tenantId,
          outageId,
          accountId: link.staffId,
          toldAt: new Date(),
        },
      });
      return outageId;
    },
  },
];

describe('RLS isolation — energy and utilities (ADR 0066)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Energy ${label}`);
    const unit = await createUnit(h, tenantId);
    const staff = await createAccountRow(h, tenantId, 'staff');
    const s = { tenantId, unitId: unit.id, staffId: staff.id } as Side;
    await inTenant(s, async (tx) => {
      s.meterId = await meter(tx, s);
      s.readingId = await reading(tx, s, s);
      s.fileId = await file(tx, tenantId);
      s.importId = await readingImport(tx, s, s);
      s.outageId = await outage(tx, s);
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
      spare.files.push(await file(tx, a.tenantId));
      spare.outages.push(await outage(tx, a));
    });
  });

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20261215090000' && m < '20261216')
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
