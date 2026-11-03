import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { dbClock, dbDate } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { marketFileRow } from '../setup/market-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  accountId: string;
  itemId: string;
  occurrenceId: string;
  incidentId: string;
  unitId: string;
}

interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  linked?: boolean;
}

let numbers = 5000;

async function itemRow(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.complianceItem.create({
    data: {
      id,
      tenantId: own.tenantId,
      kind: 'insurance',
      title: 'Isolated policy',
      ownerId: link.accountId,
    },
  });
  return id;
}

async function occurrenceRow(tx: TenantTxClient, own: Side, link: Side) {
  const id = newId();
  await tx.complianceOccurrence.create({
    data: {
      id,
      tenantId: own.tenantId,
      itemId: link.itemId,
      dueOn: dbDate('2027-06-01'),
      status: 'done',
      doneOn: dbDate('2027-05-01'),
      doneAt: dbClock(),
      doneById: link.accountId,
    },
  });
  return id;
}

async function incidentRow(tx: TenantTxClient, own: Side) {
  const id = newId();
  await tx.incident.create({
    data: {
      id,
      tenantId: own.tenantId,
      number: ++numbers,
      type: 'hazard',
      severity: 'low',
      occurredAt: dbClock(),
      description: 'Isolated',
      unitId: own.unitId,
      reportedById: own.accountId,
    },
  });
  return id;
}

/**
 * The tables of ADR 0087: isolated like every other tenant table, linked
 * with composite keys. The RLS coverage test checks the policies exist;
 * this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'compliance_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.complianceSettings.create({
        data: { tenantId: own.tenantId, leadDays: [30] },
      });
      return own.tenantId;
    },
  },
  { table: 'compliance_items', insert: itemRow },
  { table: 'compliance_occurrences', insert: occurrenceRow },
  {
    table: 'compliance_evidence',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.complianceEvidence.create({
        data: {
          id,
          tenantId: own.tenantId,
          occurrenceId: link.occurrenceId,
          fileId: await marketFileRow(tx, own.tenantId, 'compliance_evidence'),
          addedById: link.accountId,
          addedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'incident_actions',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.incidentAction.create({
        data: {
          id,
          tenantId: own.tenantId,
          incidentId: link.incidentId,
          description: 'An isolated action',
          ownerId: link.accountId,
          dueOn: dbDate('2027-06-01'),
          createdById: link.accountId,
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — compliance and corrective actions (ADR 0087)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Compliance ${label}`);
    const s: Side = {
      tenantId,
      accountId: (await createAccountRow(h, tenantId)).id,
      itemId: '',
      occurrenceId: '',
      incidentId: '',
      unitId: (await createUnit(h, tenantId)).id,
    };
    await inTenant(s, async (tx) => {
      s.itemId = await itemRow(tx, s, s);
      s.occurrenceId = await occurrenceRow(tx, s, s);
      s.incidentId = await incidentRow(tx, s);
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
      .filter((m) => m >= '20270518090000' && m < '20270519')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ].map((x) => x[1]),
      );
    expect(TABLES.map((t) => t.table).sort()).toEqual(created.sort());
  });

  it('an item may not name another compound’s staff member', async () => {
    await expect(
      inTenant(a, (tx) =>
        tx.complianceItem.create({
          data: {
            id: newId(),
            tenantId: a.tenantId,
            kind: 'lift',
            title: 'Cross',
            ownerId: b.accountId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
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
              /permission denied|never|once/.test(e.message)
                ? 0
                : Promise.reject(e),
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
