import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { permitRow } from '../setup/permits-rows';
import {
  blocklistRow,
  incidentAckRow,
  incidentNoteRow,
  incidentPhotoRow,
  incidentRow,
  lockdownRow,
  matchRow,
  overrideRow,
  refusalRow,
  violationPaymentRow,
  violationRow,
  workStopRow,
} from '../setup/security-ops-rows';
import { dutyFileRow, gateRow, shiftRow } from '../setup/security-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  gateId: string;
  shiftId: string;
  lockdownId: string;
  entryId: string;
  unitId: string;
  incidentId: string;
  violationId: string;
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
 * The security tables of ADR 0053: isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'gate_lockdowns',
    insert: (tx, own, link) =>
      lockdownRow(tx, {
        tenantId: own.tenantId,
        gateId: link.gateId,
        guardId: link.accountId,
        shiftId: link.shiftId,
      }),
  },
  {
    table: 'gate_lockdown_overrides',
    insert: (tx, own, link) =>
      overrideRow(tx, {
        tenantId: own.tenantId,
        lockdownId: link.lockdownId,
        gateId: link.gateId,
        shiftId: link.shiftId,
        guardId: link.accountId,
      }),
  },
  {
    table: 'blocklist_entries',
    insert: (tx, own, link) =>
      blocklistRow(tx, { tenantId: own.tenantId, createdById: link.accountId }),
  },
  {
    table: 'blocklist_matches',
    insert: (tx, own, link) =>
      matchRow(tx, {
        tenantId: own.tenantId,
        entryId: link.entryId,
        actorId: link.accountId,
        gateId: link.gateId,
      }),
  },
  {
    table: 'security_refusals',
    key: 'subject_id',
    // A pointer to a subject, no foreign key: nothing to link.
    linked: false,
    insert: (tx, own) => refusalRow(tx, { tenantId: own.tenantId }),
  },
  {
    table: 'permit_work_stops',
    // A works permit of its own each time: one live stop per permit.
    insert: async (tx, own, link) =>
      workStopRow(tx, {
        tenantId: own.tenantId,
        permitId: await permitRow(tx, {
          tenantId: own.tenantId,
          unitId: own.unitId,
          requestedById: own.accountId,
        }),
        stoppedById: link.accountId,
      }),
  },
  {
    table: 'incidents',
    insert: (tx, own, link) =>
      incidentRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        reportedById: link.accountId,
      }),
  },
  {
    table: 'incident_photos',
    insert: async (tx, own, link) =>
      incidentPhotoRow(tx, {
        tenantId: own.tenantId,
        incidentId: link.incidentId,
        fileId: await dutyFileRow(tx, own.tenantId, 'incident_photo'),
        uploadedById: link.accountId,
      }),
  },
  {
    table: 'incident_notes',
    insert: (tx, own, link) =>
      incidentNoteRow(tx, {
        tenantId: own.tenantId,
        incidentId: link.incidentId,
        authorId: link.accountId,
      }),
  },
  {
    table: 'incident_acknowledgements',
    key: 'incident_id',
    // One per incident and role: an incident of its own each time.
    insert: async (tx, own, link) =>
      incidentAckRow(tx, {
        tenantId: own.tenantId,
        incidentId: await incidentRow(tx, {
          tenantId: own.tenantId,
          unitId: own.unitId,
          reportedById: own.accountId,
        }),
        accountId: link.accountId,
      }),
  },
  {
    table: 'unit_violations',
    insert: (tx, own, link) =>
      violationRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        issuedById: link.accountId,
      }),
  },
  {
    table: 'unit_violation_payments',
    insert: (tx, own, link) =>
      violationPaymentRow(tx, {
        tenantId: own.tenantId,
        violationId: link.violationId,
        recordedById: link.accountId,
      }),
  },
];

describe('RLS isolation — security tables (ADR 0053)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Security ops ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      gateId: '',
      shiftId: '',
      lockdownId: '',
      entryId: '',
      unitId: (await createUnit(h, tenantId)).id,
      incidentId: '',
      violationId: '',
    };
    await inTenant(s, async (tx) => {
      s.gateId = await gateRow(tx, tenantId);
      s.shiftId = await shiftRow(tx, {
        tenantId,
        guardId: s.accountId,
        gateId: s.gateId,
      });
      s.lockdownId = await lockdownRow(tx, {
        tenantId,
        gateId: s.gateId,
        guardId: s.accountId,
        shiftId: s.shiftId,
      });
      s.entryId = await blocklistRow(tx, {
        tenantId,
        createdById: s.accountId,
      });
      s.incidentId = await incidentRow(tx, {
        tenantId,
        unitId: s.unitId,
        reportedById: s.accountId,
      });
      s.violationId = await violationRow(tx, {
        tenantId,
        unitId: s.unitId,
        issuedById: s.accountId,
        amount: '100',
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

  describe('gate_lockdown_states (one row per compound, provisioned)', () => {
    const count = (s: Side, of: Side) =>
      inTenant(s, async (tx) =>
        Number(
          (
            await tx.$queryRaw<{ n: bigint }[]>`
              SELECT count(*) AS n FROM gate_lockdown_states
               WHERE tenant_id = ${of.tenantId}::uuid`
          )[0].n,
        ),
      );

    it('A sees its own row; B does not see A’s', async () => {
      expect(await count(a, a)).toBe(1);
      expect(await count(b, a)).toBe(0);
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      await expect(
        inTenant(
          b,
          (tx) =>
            tx.$executeRaw`INSERT INTO gate_lockdown_states (tenant_id)
                         VALUES (${a.tenantId}::uuid)`,
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('B locks nothing of A: a FOR UPDATE finds no row', async () => {
      const rows = await inTenant(
        b,
        (tx) =>
          tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT tenant_id FROM gate_lockdown_states
           WHERE tenant_id = ${a.tenantId}::uuid FOR UPDATE`,
      );
      expect(rows).toEqual([]);
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
