import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  areaRow,
  expiryReminderRow,
  finePaymentRow,
  fineRow,
  parkingBookingRow,
  reportRow,
  slotRow,
  stickerRow,
  vehicleRow,
} from '../setup/vehicles-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  vehicleId: string;
  areaId: string;
  fineId: string;
}

/**
 * One vehicles table: how to insert a row in a compound. `link` points the
 * row's foreign keys at another compound's rows, which the composite keys
 * must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  key?: string;
  linked?: boolean;
}

/**
 * The vehicles and parking tables (ADR 0045): isolated like every other
 * tenant table, linked with composite keys. The RLS coverage test checks
 * the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'vehicles',
    insert: (tx, own, link) =>
      vehicleRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        registeredById: link.accountId,
      }),
  },
  {
    table: 'vehicle_stickers',
    insert: (tx, own, link) =>
      stickerRow(tx, {
        tenantId: own.tenantId,
        vehicleId: link.vehicleId,
        issuedById: link.accountId,
      }),
  },
  {
    table: 'vehicle_expiry_reminders',
    insert: (tx, own, link) =>
      expiryReminderRow(tx, {
        tenantId: own.tenantId,
        vehicleId: link.vehicleId,
      }),
  },
  {
    table: 'unit_parking_slots',
    insert: (tx, own, link) =>
      slotRow(tx, { tenantId: own.tenantId, unitId: link.unitId }),
  },
  {
    table: 'visitor_parking_areas',
    insert: (tx, own) => areaRow(tx, own.tenantId),
    linked: false,
  },
  {
    table: 'visitor_parking_bookings',
    insert: (tx, own, link) =>
      parkingBookingRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        areaId: link.areaId,
        bookedById: link.accountId,
      }),
  },
  {
    table: 'vehicle_fines',
    insert: (tx, own, link) =>
      fineRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        issuedById: link.accountId,
      }),
  },
  {
    table: 'vehicle_fine_payments',
    insert: (tx, own, link) =>
      finePaymentRow(tx, {
        tenantId: own.tenantId,
        fineId: link.fineId,
        recordedById: link.accountId,
      }),
  },
  {
    table: 'parking_reports',
    insert: (tx, own, link) =>
      reportRow(tx, { tenantId: own.tenantId, reporterId: link.accountId }),
  },
];

describe('RLS isolation — vehicles and parking tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Vehicles ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      vehicleId: '',
      areaId: '',
      fineId: '',
    };
    await inTenant(s, async (tx) => {
      s.vehicleId = await vehicleRow(tx, {
        tenantId,
        unitId: s.unitId,
        registeredById: s.accountId,
      });
      s.areaId = await areaRow(tx, tenantId);
      s.fineId = await fineRow(tx, {
        tenantId,
        unitId: s.unitId,
        issuedById: s.accountId,
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
