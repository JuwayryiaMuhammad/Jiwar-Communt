import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import {
  heldMeetingRow,
  meetingActionRow,
  scheduledMeetingRow,
} from '../setup/board-work-rows';
import { dbClock } from '../setup/compound-clock';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { boardMemberRow, boardTermRow } from '../setup/governance-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  termId: string;
  memberId: string;
  heldMeetingId: string;
  scheduledMeetingId: string;
}

/**
 * One table of the board's work: how to insert a row in a compound.
 * `link` points the row's foreign keys at another compound's rows, which
 * the composite keys must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
}

let reportVersion = 0;

/**
 * The tables of the board's work (ADR 0075): isolated like every other
 * tenant table, linked with composite keys. The RLS coverage test checks
 * the policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'governance_unit_shares',
    key: 'unit_id',
    insert: async (tx, own, link) => {
      await tx.governanceUnitShare.create({
        data: {
          tenantId: own.tenantId,
          unitId: link.unitId,
          share: '1',
          updatedById: link.accountId,
          updatedAt: dbClock(),
        },
      });
      return link.unitId;
    },
  },
  {
    table: 'governance_rules',
    key: 'tenant_id',
    // One row per compound: the second write to it is the link's update.
    insert: async (tx, own, link) => {
      await tx.governanceRules.upsert({
        where: { tenantId: own.tenantId },
        create: {
          tenantId: own.tenantId,
          updatedById: link.accountId,
          updatedAt: dbClock(),
        },
        update: { updatedById: link.accountId, updatedAt: dbClock() },
      });
      return own.tenantId;
    },
  },
  {
    table: 'board_meetings',
    insert: (tx, own, link) =>
      heldMeetingRow(tx, {
        tenantId: own.tenantId,
        termId: link.termId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'board_meeting_agenda_items',
    key: 'meeting_id',
    // A scheduled meeting of its own each time: its agenda is empty.
    insert: async (tx, own, link) => {
      const meetingId =
        own === link
          ? await scheduledMeetingRow(tx, {
              tenantId: own.tenantId,
              termId: own.termId,
              createdById: own.accountId,
            })
          : link.scheduledMeetingId;
      await tx.boardMeetingAgendaItem.create({
        data: {
          tenantId: own.tenantId,
          meetingId,
          position: 1,
          kind: 'other',
          title: 'An agenda row',
        },
      });
      return meetingId;
    },
  },
  {
    table: 'board_meeting_attendance',
    key: 'meeting_id',
    insert: async (tx, own, link) => {
      await tx.boardMeetingAttendance.create({
        data: {
          tenantId: own.tenantId,
          meetingId: link.heldMeetingId,
          memberId: link.memberId,
          present: true,
        },
      });
      return link.heldMeetingId;
    },
  },
  {
    table: 'board_meeting_actions',
    insert: (tx, own, link) =>
      meetingActionRow(tx, {
        tenantId: own.tenantId,
        meetingId: link.heldMeetingId,
        ownerId: link.accountId,
      }),
  },
  {
    table: 'board_handover_packs',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.boardHandoverPack.create({
        data: {
          id,
          tenantId: own.tenantId,
          termId: link.termId,
          contents: {},
          generatedAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'manager_handovers',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.managerHandover.create({
        data: {
          id,
          tenantId: own.tenantId,
          accountId: link.accountId,
          createdAt: dbClock(),
        },
      });
      return id;
    },
  },
  {
    table: 'board_reports',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.boardReport.create({
        data: {
          id,
          tenantId: own.tenantId,
          period: new Date(Date.UTC(2026, 0, 1)),
          // A version of its own each time: one per compound, period and version.
          version: ++reportVersion,
          contents: {},
          generatedAt: dbClock(),
          generatedById: link.accountId,
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — the board’s work (ADR 0075)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Board work ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      termId: '',
      memberId: '',
      heldMeetingId: '',
      scheduledMeetingId: '',
    };
    await inTenant(s, async (tx) => {
      s.termId = await boardTermRow(tx, {
        tenantId,
        createdById: s.accountId,
        open: true,
      });
      s.memberId = await boardMemberRow(tx, {
        tenantId,
        termId: s.termId,
        accountId: s.accountId,
        addedById: s.accountId,
      });
      s.heldMeetingId = await heldMeetingRow(tx, {
        tenantId,
        termId: s.termId,
        createdById: s.accountId,
      });
      s.scheduledMeetingId = await scheduledMeetingRow(tx, {
        tenantId,
        termId: s.termId,
        createdById: s.accountId,
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

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270216090000' && m < '20270217')
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
