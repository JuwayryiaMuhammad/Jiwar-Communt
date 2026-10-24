import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { newId } from '../../src/core/common/uuid';
import {
  appealRow,
  approvalRequestRow,
  boardMemberRow,
  boardTermRow,
  closedContestRows,
  contestRow,
  electionRows,
  motionRow,
  openContest,
  pollRow,
  publicationRows,
  representativeMatterRow,
  representativeRow,
  representativeThreadRow,
} from '../setup/governance-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  termId: string;
  representativeId: string;
  threadId: string;
  publicationId: string;
  requestId: string;
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
/** Requests' numbers: unique in each compound, whatever inserts them. */
let number = 1;

/**
 * A seat of `accountId` on the term: the one it holds already (one live
 * seat per account), or a new one (refused when the term is another
 * compound's).
 */
async function seatOn(
  tx: TenantTxClient,
  own: Side,
  termId: string,
  accountId: string,
): Promise<string> {
  const held = await tx.boardMember.findFirst({
    where: { termId, accountId, endedAt: null },
  });
  return (
    held?.id ??
    boardMemberRow(tx, {
      tenantId: own.tenantId,
      termId,
      accountId,
      addedById: own.accountId,
    })
  );
}

/** A request of `own`'s and an open motion on it by a seat of `link`'s term. */
async function motionOf(tx: TenantTxClient, own: Side, link: Side) {
  const requestId = await approvalRequestRow(tx, {
    tenantId: own.tenantId,
    raisedById: own.accountId,
    number: number++,
  });
  const memberId = await seatOn(tx, own, link.termId, link.accountId);
  return motionRow(tx, {
    tenantId: own.tenantId,
    requestId,
    termId: link.termId,
    memberId,
    accountId: link.accountId,
  });
}

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
  // Board matters (ADR 0055).
  {
    table: 'governance_approval_settings',
    insert: async (tx, own) => {
      await tx.governanceApprovalSetting.upsert({
        where: {
          tenantId_type: { tenantId: own.tenantId, type: 'legal_escalation' },
        },
        create: {
          tenantId: own.tenantId,
          type: 'legal_escalation',
          deadlineDays: 14,
        },
        update: {},
      });
      return own.tenantId;
    },
    key: 'tenant_id',
    linked: false,
  },
  {
    table: 'governance_approval_requests',
    insert: (tx, own, link) =>
      approvalRequestRow(tx, {
        tenantId: own.tenantId,
        raisedById: link.accountId,
        number: number++,
      }),
  },
  {
    table: 'governance_approval_alternatives',
    insert: async (tx, own, link) => {
      const requestId = await approvalRequestRow(tx, {
        tenantId: own.tenantId,
        raisedById: link.accountId,
        number: number++,
      });
      await tx.governanceApprovalAlternative.create({
        data: { tenantId: own.tenantId, requestId, position: 1, text: 'Alt' },
      });
      return requestId;
    },
    key: 'request_id',
  },
  {
    table: 'board_motions',
    insert: (tx, own, link) => motionOf(tx, own, link),
  },
  {
    table: 'board_votes',
    insert: async (tx, own, link) => {
      const motionId = await motionOf(tx, own, own);
      const id = newId();
      const seat = await tx.boardMember.findFirstOrThrow({
        where: { termId: own.termId },
        orderBy: { addedAt: 'desc' },
      });
      await tx.boardVote.create({
        data: {
          id,
          tenantId: own.tenantId,
          motionId,
          memberId: seat.id,
          accountId: link.accountId,
          choice: 'for',
          castAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'governance_board_appeals',
    insert: (tx, own, link) =>
      appealRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        appellantId: own.accountId,
        number: number++,
      }),
  },
  // ADR 0059: building representatives, the board's matters on them, and
  // their threads.
  {
    table: 'governance_representatives',
    insert: (tx, own, link) =>
      representativeRow(tx, {
        tenantId: own.tenantId,
        building: `B-${number++}`,
        unitId: link.unitId,
        accountId: link.accountId,
        appointedById: link.accountId,
      }),
  },
  {
    table: 'governance_representative_matters',
    insert: (tx, own, link) =>
      representativeMatterRow(tx, {
        tenantId: own.tenantId,
        building: `M-${number++}`,
        accountId: link.accountId,
        raisedById: link.accountId,
      }),
  },
  {
    table: 'representative_threads',
    insert: async (tx, own, link) => {
      // One thread per writer and representative: a representative of
      // its own for the row in its compound; the other's for a link.
      const representativeId =
        own === link
          ? await representativeRow(tx, {
              tenantId: own.tenantId,
              building: `T-${number++}`,
              unitId: own.unitId,
              accountId: own.accountId,
              appointedById: own.accountId,
            })
          : link.representativeId;
      return representativeThreadRow(tx, {
        tenantId: own.tenantId,
        representativeId,
        writerId: link.accountId,
        unitId: link.unitId,
      });
    },
  },
  {
    table: 'representative_messages',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.representativeMessage.create({
        data: {
          id,
          tenantId: own.tenantId,
          threadId: link.threadId,
          side: 'resident',
          authorId: link.accountId,
          body: 'A row',
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    // ADR 0059: a complaint about the management.
    table: 'management_complaints',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.managementComplaint.create({
        data: {
          id,
          tenantId: own.tenantId,
          unitId: link.unitId,
          authorId: link.accountId,
          category: 'delay',
        },
      });
      return id;
    },
  },
  {
    table: 'board_motion_recusals',
    insert: async (tx, own, link) => {
      const appealId = await appealRow(tx, {
        tenantId: own.tenantId,
        unitId: own.unitId,
        appellantId: own.accountId,
        number: number++,
      });
      const memberId = await seatOn(tx, own, own.termId, own.accountId);
      const motionId = newId();
      await tx.boardMotion.create({
        data: {
          id: motionId,
          tenantId: own.tenantId,
          boardAppealId: appealId,
          termId: own.termId,
          proposedByMemberId: memberId,
          proposedById: own.accountId,
          outcome: 'uphold',
          rationale: 'A row',
          openedAt: new Date(),
        },
      });
      await tx.boardMotionRecusal.create({
        data: {
          tenantId: own.tenantId,
          motionId,
          accountId: link.accountId,
        },
      });
      return motionId;
    },
    key: 'motion_id',
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
  // ADR 0059: the owners' voice.
  {
    table: 'governance_agenda_proposals',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.governanceAgendaProposal.create({
        data: {
          id,
          tenantId: own.tenantId,
          authorId: link.accountId,
          title: 'A row',
          body: 'Its words.',
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'governance_objections',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.governanceObjection.create({
        data: {
          id,
          tenantId: own.tenantId,
          publicationId: link.publicationId,
          // Once per unit: the row's own unit, made here, for its compound.
          unitId:
            own === link
              ? (
                  await tx.unit.create({
                    data: {
                      id: newId(),
                      tenantId: own.tenantId,
                      code: `OBJ-${number++}`,
                    },
                  })
                ).id
              : link.unitId,
          authorId: link.accountId,
          grounds: 'A row',
          createdAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'governance_objection_replies',
    key: 'publication_id',
    insert: async (tx, own, link) => {
      // One answer per publication: a publication of its own here.
      const publicationId =
        own === link
          ? await publicationRows(tx, {
              tenantId: own.tenantId,
              termId: own.termId,
              accountId: own.accountId,
            })
          : link.publicationId;
      await tx.governanceObjectionReply.create({
        data: {
          tenantId: own.tenantId,
          publicationId,
          body: 'A row',
          repliedById: link.accountId,
          createdAt: new Date(),
        },
      });
      return publicationId;
    },
  },
  {
    table: 'governance_approval_progress',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.governanceApprovalProgress.create({
        data: {
          id,
          tenantId: own.tenantId,
          requestId: link.requestId,
          status: 'in_progress',
          recordedAt: new Date(),
          recordedById: link.accountId,
        },
      });
      return id;
    },
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
      representativeId: '',
      threadId: '',
      publicationId: '',
      requestId: '',
    };
    // A second account: a thread's writer besides the representative.
    const writer = (await createAccountRow(h, tenantId)).id;
    s.termId = await inTenant(s, (tx) =>
      boardTermRow(tx, { tenantId, createdById: s.accountId }),
    );
    await inTenant(s, async (tx) => {
      s.representativeId = await representativeRow(tx, {
        tenantId,
        building: `SIDE-${label}`,
        unitId: s.unitId,
        accountId: s.accountId,
        appointedById: s.accountId,
      });
      s.threadId = await representativeThreadRow(tx, {
        tenantId,
        representativeId: s.representativeId,
        writerId: writer,
        unitId: s.unitId,
      });
      s.publicationId = await publicationRows(tx, {
        tenantId,
        termId: s.termId,
        accountId: s.accountId,
      });
      s.requestId = await approvalRequestRow(tx, {
        tenantId,
        raisedById: s.accountId,
        number: number++,
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
