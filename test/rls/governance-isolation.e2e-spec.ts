import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  boardMemberRow,
  boardTermRow,
  closedContestRows,
  contestRow,
  electionRows,
  openContest,
  pollRow,
  publicationRows,
} from '../setup/governance-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  termId: string;
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
 * The governance tables (ADR 0051): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'board_terms',
    insert: (tx, own, link) =>
      boardTermRow(tx, { tenantId: own.tenantId, createdById: link.accountId }),
  },
  {
    table: 'board_members',
    insert: (tx, own, link) =>
      boardMemberRow(tx, {
        tenantId: own.tenantId,
        termId: link.termId,
        accountId: link.accountId,
        addedById: own.accountId,
      }),
  },
  {
    table: 'governance_contests',
    insert: (tx, own) => contestRow(tx, { tenantId: own.tenantId }),
    linked: false,
  },
  {
    table: 'governance_electors',
    insert: async (tx, own, link) => {
      const contestId = await contestRow(tx, { tenantId: own.tenantId });
      await openContest(tx, {
        tenantId: own.tenantId,
        contestId,
        electors: [{ unitId: link.unitId, accountId: link.accountId }],
      });
      return contestId;
    },
    key: 'contest_id',
  },
  {
    // A secret contest's participation, box and ballot rows, as a close
    // leaves them (the box is gone by then: see the box's own entry).
    table: 'governance_participations',
    insert: (tx, own, link) =>
      closedContestRows(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        accountId: link.accountId,
      }),
    key: 'contest_id',
  },
  {
    table: 'governance_ballots',
    insert: (tx, own) =>
      closedContestRows(tx, {
        tenantId: own.tenantId,
        unitId: own.unitId,
        accountId: own.accountId,
      }),
    key: 'contest_id',
    linked: false,
  },
  {
    table: 'governance_ballot_boxes',
    insert: async (tx, own) => {
      const contestId = await contestRow(tx, { tenantId: own.tenantId });
      await openContest(tx, {
        tenantId: own.tenantId,
        contestId,
        electors: [],
      });
      return contestId;
    },
    key: 'contest_id',
    linked: false,
  },
  {
    table: 'governance_counters',
    insert: async (tx, own) => {
      await tx.governanceCounter.upsert({
        where: { tenantId_kind: { tenantId: own.tenantId, kind: 'poll' } },
        create: { tenantId: own.tenantId, kind: 'poll', lastNumber: 1 },
        update: {},
      });
      return own.tenantId;
    },
    key: 'tenant_id',
    linked: false,
  },
  {
    table: 'governance_polls',
    insert: (tx, own, link) =>
      pollRow(tx, { tenantId: own.tenantId, createdById: link.accountId }),
  },
  {
    table: 'governance_poll_options',
    insert: async (tx, own) => {
      await pollRow(tx, { tenantId: own.tenantId, createdById: own.accountId });
      const [o] = await tx.governancePollOption.findMany({
        orderBy: { id: 'desc' },
        take: 1,
      });
      return o.id;
    },
    linked: false,
  },
  {
    table: 'governance_elections',
    insert: async (tx, own, link) =>
      (
        await electionRows(tx, {
          tenantId: own.tenantId,
          createdById: link.accountId,
        })
      ).electionId,
  },
  {
    table: 'governance_candidates',
    insert: async (tx, own, link) =>
      (
        await electionRows(tx, {
          tenantId: own.tenantId,
          createdById: own.accountId,
          candidateId: link.accountId,
        })
      ).candidateId,
  },
  {
    table: 'board_publications',
    insert: (tx, own, link) =>
      publicationRows(tx, {
        tenantId: own.tenantId,
        termId: link.termId,
        accountId: own.accountId,
      }),
  },
];

describe('RLS isolation — governance tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Governance ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      termId: '',
    };
    s.termId = await inTenant(s, (tx) =>
      boardTermRow(tx, { tenantId, createdById: s.accountId }),
    );
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
