import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  entryPhotoRow,
  evidenceRow,
  fieldExceptionRow,
  geofenceExitRow,
  incidentMediaRow,
  noteMediaRow,
  patrolNoteRow,
  signatureRow,
  overstayAlertRow,
  patrolRunRow,
  serviceVehicleRow,
  vehicleCountRow,
} from '../setup/gate-completion-rows';
import { incidentRow } from '../setup/security-ops-rows';
import { gateRow, shiftRow } from '../setup/security-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  gateId: string;
  shiftId: string;
  unitId: string;
  incidentId: string;
  photoEntryId: string;
  runId: string;
  noteId: string;
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
 * The tables of the gate's completion (ADR 0056): isolated like every
 * other tenant table, linked with composite keys. The RLS coverage test
 * checks the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'gate_field_exceptions',
    insert: (tx, own, link) =>
      fieldExceptionRow(tx, {
        tenantId: own.tenantId,
        gateId: link.gateId,
        shiftId: link.shiftId,
        guardId: link.accountId,
        unitId: link.unitId,
      }),
  },
  {
    table: 'gate_entry_photos',
    key: 'entry_id',
    // Its file is made in the row's own compound; its gate, unit and guard
    // are the link's, which the composite keys refuse.
    insert: (tx, own, link) =>
      entryPhotoRow(tx, {
        tenantId: own.tenantId,
        gateId: link.gateId,
        unitId: link.unitId,
        guardId: link.accountId,
      }),
  },
  {
    table: 'incident_evidence',
    insert: (tx, own, link) =>
      evidenceRow(tx, {
        tenantId: own.tenantId,
        incidentId: link.incidentId,
        entryId: link.photoEntryId,
        byId: link.accountId,
      }),
  },
  {
    // One row per day, gate and direction: its gate names it here.
    table: 'gate_vehicle_counts',
    key: 'gate_id',
    insert: (tx, own, link) =>
      vehicleCountRow(tx, { tenantId: own.tenantId, gateId: link.gateId }),
  },
  {
    table: 'service_vehicle_visits',
    insert: (tx, own, link) =>
      serviceVehicleRow(tx, {
        tenantId: own.tenantId,
        gateId: link.gateId,
        shiftId: link.shiftId,
        guardId: link.accountId,
      }),
  },
  {
    table: 'patrol_note_media',
    insert: (tx, own, link) =>
      noteMediaRow(tx, {
        tenantId: own.tenantId,
        noteId: link.noteId,
        byId: link.accountId,
      }),
  },
  {
    table: 'incident_media',
    insert: (tx, own, link) =>
      incidentMediaRow(tx, {
        tenantId: own.tenantId,
        incidentId: link.incidentId,
        byId: link.accountId,
      }),
  },
  {
    table: 'incident_signatures',
    insert: (tx, own, link) =>
      signatureRow(tx, {
        tenantId: own.tenantId,
        incidentId: link.incidentId,
        signerId: link.accountId,
      }),
  },
  {
    table: 'patrol_geofence_exits',
    insert: (tx, own, link) =>
      geofenceExitRow(tx, {
        tenantId: own.tenantId,
        runId: link.runId,
        guardId: link.accountId,
      }),
  },
  {
    table: 'visit_overstay_alerts',
    key: 'entry_id',
    insert: (tx, own, link) =>
      overstayAlertRow(tx, {
        tenantId: own.tenantId,
        gateId: link.gateId,
        unitId: link.unitId,
      }),
  },
];

describe('RLS isolation — the gate’s completion (ADR 0056)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Gate completion ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      gateId: '',
      shiftId: '',
      unitId: (await createUnit(h, tenantId)).id,
      incidentId: '',
      photoEntryId: '',
      runId: '',
      noteId: '',
    };
    await inTenant(s, async (tx) => {
      s.gateId = await gateRow(tx, tenantId);
      s.shiftId = await shiftRow(tx, {
        tenantId,
        guardId: s.accountId,
        gateId: s.gateId,
      });
      s.incidentId = await incidentRow(tx, {
        tenantId,
        unitId: s.unitId,
        reportedById: s.accountId,
      });
      s.photoEntryId = await entryPhotoRow(tx, {
        tenantId,
        gateId: s.gateId,
        unitId: s.unitId,
        guardId: s.accountId,
      });
      s.runId = await patrolRunRow(tx, {
        tenantId,
        gateId: s.gateId,
        createdById: s.accountId,
      });
      s.noteId = await patrolNoteRow(tx, {
        tenantId,
        gateId: s.gateId,
        guardId: s.accountId,
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

  describe('gate_settings (one row per compound, provisioned)', () => {
    const count = (s: Side, of: Side) =>
      inTenant(s, async (tx) =>
        Number(
          (
            await tx.$queryRaw<{ n: bigint }[]>`
              SELECT count(*) AS n FROM gate_settings
               WHERE tenant_id = ${of.tenantId}::uuid`
          )[0].n,
        ),
      );

    it('A sees its own row; B does not see A’s', async () => {
      expect(await count(a, a)).toBe(1);
      expect(await count(b, a)).toBe(0);
    });

    it('acting as B, a row with A’s tenant_id is refused; B changes nothing of A', async () => {
      await expect(
        inTenant(
          b,
          (tx) =>
            tx.$executeRaw`INSERT INTO gate_settings (tenant_id, updated_at)
                         VALUES (${a.tenantId}::uuid, now())`,
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        await inTenant(
          b,
          (tx) =>
            tx.$executeRaw`UPDATE gate_settings SET exception_answer_minutes = 5
                         WHERE tenant_id = ${a.tenantId}::uuid`,
        ),
      ).toBe(0);
    });
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
          /foreign key|violates/i,
        );
      });
    }
  });
});
