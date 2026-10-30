import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { gateRow, shiftRow } from '../setup/security-rows';
import { personRow } from '../setup/security-ops-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  gateId: string;
  shiftId: string;
  entryId: string;
  deviceId: string;
  unitId: string;
  callId: string;
}

/**
 * One table: how to insert a row in a compound. `link` points the row's
 * foreign keys at another compound's rows, which the composite keys must
 * refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  key?: string;
  linked?: boolean;
}

/**
 * The tables of the guard vendor adapters (ADR 0068): isolated like every
 * other tenant table, linked with composite keys. The RLS coverage test
 * checks the policies exist; this suite checks they hold, table by table.
 */
let devices = 0;

/** A wearable of a reference of its own: one live device a reference is never in the way. */
async function alarmDevice(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.guardAlarmDevice.create({
    data: {
      id,
      tenantId: own.tenantId,
      deviceRef: `iso-${++devices}`,
      label: 'Vest',
      registeredByAccountId: link.accountId,
    },
  });
  return id;
}

/** An ended call: one live a guard and a unit is never in the way. */
async function gateCall(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.gateCall.create({
    data: {
      id,
      tenantId: own.tenantId,
      unitId: link.unitId,
      guardAccountId: link.accountId,
      shiftId: link.shiftId,
      gateId: link.gateId,
      reasonCode: 'other',
      status: 'missed',
      endedAt: new Date(),
      endReason: 'missed',
    },
  });
  return id;
}

const TABLES: Table[] = [
  { table: 'gate_calls', insert: gateCall },
  {
    table: 'gate_call_vendor_events',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.gateCallVendorEvent.create({
        data: {
          id,
          tenantId: own.tenantId,
          callId: link.callId,
          roomRef: `room-${id}`,
          vendorEventId: id,
          kind: 'room_closed',
          occurredAt: new Date(),
        },
      });
      return id;
    },
  },
  { table: 'guard_alarm_devices', insert: alarmDevice },
  {
    table: 'guard_alarm_pairings',
    insert: async (tx, own, link) => {
      const id = newId();
      // Ended: one open a device and a guard is never in the way.
      await tx.guardAlarmPairing.create({
        data: {
          id,
          tenantId: own.tenantId,
          deviceId: link.deviceId,
          guardAccountId: link.accountId,
          shiftId: link.shiftId,
          endedAt: new Date(),
          endReason: 'unpaired',
        },
      });
      return id;
    },
  },
  {
    table: 'guard_alarm_events',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.guardAlarmEvent.create({
        data: {
          id,
          tenantId: own.tenantId,
          deviceRef: `iso-event-${id}`,
          vendorEventId: id,
          kind: 'panic',
          occurredAt: new Date(),
          deviceId: link.deviceId,
          outcome: 'unpaired',
        },
      });
      return id;
    },
  },
  {
    table: 'control_room_events',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.controlRoomEvent.create({
        data: {
          id,
          tenantId: own.tenantId,
          kind: 'lockdown_started',
          severity: 'high',
          sourceType: 'lockdown',
          sourceId: newId(),
          gateId: link.gateId,
          shiftId: link.shiftId,
          acknowledgedAt: new Date(),
          acknowledgedByAccountId: link.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'gate_face_enrollments',
    insert: async (tx, own, link) => {
      const id = newId();
      // Removed: one live enrolment an entry is never in the way.
      await tx.gateFaceEnrollment.create({
        data: {
          id,
          tenantId: own.tenantId,
          entryId: link.entryId,
          status: 'removed',
          removingAt: new Date(),
          removedAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'gate_face_checks',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.gateFaceCheck.create({
        data: {
          id,
          tenantId: own.tenantId,
          shiftId: link.shiftId,
          gateId: link.gateId,
          guardAccountId: link.accountId,
          probeDeletedAt: new Date(),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — the guard vendor adapters (ADR 0068)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Guard vendors ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      gateId: '',
      shiftId: '',
      entryId: '',
      deviceId: '',
      unitId: (await createUnit(h, tenantId)).id,
      callId: '',
    };
    await inTenant(s, async (tx) => {
      s.gateId = await gateRow(tx, tenantId);
      s.shiftId = await shiftRow(tx, {
        tenantId,
        guardId: s.accountId,
        gateId: s.gateId,
      });
      s.entryId = await personRow(tx, {
        tenantId,
        createdById: s.accountId,
      });
      s.deviceId = await alarmDevice(tx, s, s);
      s.callId = await gateCall(tx, s, s);
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

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20261229090000' && m < '20261230')
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
