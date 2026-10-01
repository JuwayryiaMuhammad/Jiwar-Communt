import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  /** A staff account and a gate, for the gate tables. */
  guardId: string;
  gateId: string;
}

/**
 * One new Phase 4 tenant table: how to insert a row in a compound. `link`
 * points the row's foreign keys at another compound's rows, which the
 * composite keys must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** Column used to address the row (default `id`). */
  key?: string;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

/**
 * Phase 4 tenant tables (ADR 0027, 0028): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'notifications',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.notification.create({
        data: {
          id,
          tenantId: own.tenantId,
          accountId: link.accountId,
          kind: 'worker.entered',
          priority: 'normal',
          params: { unitCode: 'X' },
        },
      });
      return id;
    },
  },
  {
    table: 'idempotency_keys',
    key: 'resource_id',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.idempotencyKey.create({
        data: {
          tenantId: own.tenantId,
          accountId: link.accountId,
          key: `key-${id}`,
          requestHash: 'x',
          route: '/probe',
          resourceType: 'probe',
          resourceId: id,
          responseStatus: 201,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      return id;
    },
  },
  {
    table: 'gates',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.gate.create({
        data: { id, tenantId: own.tenantId, name: `G ${id}`, kind: 'vehicle' },
      });
      return id;
    },
  },
  {
    table: 'guard_shifts',
    insert: async (tx, own, link) => {
      const id = newId();
      // Ended, so a second row for the same guard is allowed.
      await tx.guardShift.create({
        data: {
          id,
          tenantId: own.tenantId,
          guardAccountId: link.guardId,
          gateId: link.gateId,
          startedAt: new Date(Date.now() - 60_000),
          endedAt: new Date(),
          endReason: 'guard',
        },
      });
      return id;
    },
  },
  {
    table: 'visitor_details',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.visitorDetails.create({
        data: {
          id,
          tenantId: own.tenantId,
          fullName: 'Visitor',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      return id;
    },
  },
  {
    table: 'visitor_passes',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.visitorPass.create({
        data: {
          id,
          tenantId: own.tenantId,
          unitId: link.unitId,
          hostAccountId: link.accountId,
          kind: 'one_time',
          partySize: 1,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 3_600_000),
          codeHash: id.replace(/-/g, '').padEnd(64, '0'),
        },
      });
      return id;
    },
  },
  {
    table: 'unit_gate_instructions',
    key: 'unit_id',
    insert: async (tx, own, link) => {
      // Keyed by unit: a fresh unit each time, in the row's own compound.
      const unitId =
        link === own
          ? (
              await tx.unit.create({
                data: {
                  id: newId(),
                  tenantId: own.tenantId,
                  code: `GI-${newId()}`,
                },
              })
            ).id
          : link.unitId;
      await tx.unitGateInstruction.create({
        data: {
          tenantId: own.tenantId,
          unitId,
          updatedById: link.accountId,
        },
      });
      return unitId;
    },
  },
  {
    // Append-only and without foreign keys, like the audit tables.
    table: 'gate_entries',
    linked: false,
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.gateEntry.create({
        data: {
          id,
          tenantId: own.tenantId,
          gateId: link.gateId,
          shiftId: newId(),
          guardAccountId: link.guardId,
          subjectType: 'visitor_pass',
          subjectId: newId(),
          unitId: link.unitId,
          direction: 'in',
          method: 'code',
          occurredAt: new Date(),
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — Phase 4 tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Gate ${label}`);
    const unit = await createUnit(h, tenantId);
    const account = await createAccountRow(h, tenantId, 'resident');
    const guard = await createAccountRow(h, tenantId, 'staff');
    const gateId = newId();
    await h.asTenant(tenantId, () =>
      h.prisma.tenant.gate.create({
        data: { id: gateId, tenantId, name: 'Fixture gate', kind: 'mixed' },
      }),
    );
    return {
      tenantId,
      unitId: unit.id,
      accountId: account.id,
      guardId: guard.id,
      gateId,
    };
  };

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

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
      // An append-only table refuses UPDATE outright, which is also nothing.
      const changed = await inTenant(b, (tx) =>
        tx
          .$executeRawUnsafe(
            `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::uuid`,
            ids[name],
          )
          .catch((e: Error) =>
            /permission denied/.test(e.message) ? 0 : Promise.reject(e),
          ),
      );
      expect(changed).toBe(0);
      const deleted = await inTenant(b, (tx) =>
        tx
          .$executeRawUnsafe(
            `DELETE FROM "${name}" WHERE "${key}" = $1::uuid`,
            ids[name],
          )
          .catch((e: Error) =>
            /permission denied/.test(e.message) ? 0 : Promise.reject(e),
          ),
      );
      expect(deleted).toBe(0);
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
