import { randomBytes } from 'node:crypto';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import {
  announcementRow,
  communityFileRow,
  eventRow,
  pollRow,
  suggestionRow,
  suggestionTopicRow,
  versionRow,
} from '../setup/engagement-rows';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  topicId: string;
  announcementId: string;
  eventId: string;
  pollId: string;
  suggestionId: string;
}

/**
 * One table of the community life: how to insert a row in a compound.
 * `link` points the row's foreign keys at another compound's rows, which
 * the composite keys must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** The column the row is found by (`id` unless the table has none). */
  key?: string;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

/** A parent of the row's own when it is not being linked across. */
const parent = async (
  own: Side,
  link: Side,
  shared: string,
  fresh: () => Promise<string>,
) => (own === link ? fresh() : shared);

/**
 * The community life's tables (ADR 0040): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'engagement_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.engagementSettings.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'suggestion_topics',
    linked: false,
    insert: (tx, own) => suggestionTopicRow(tx, own.tenantId),
  },
  {
    table: 'announcements',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.announcement.create({
        data: {
          id,
          tenantId: own.tenantId,
          kind: 'general',
          createdById: link.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'announcement_versions',
    insert: (tx, own, link) =>
      versionRow(tx, {
        tenantId: own.tenantId,
        announcementId: link.announcementId,
        editedById: own.accountId,
        version: 2 + Math.floor(Math.random() * 1_000_000),
      }),
  },
  {
    table: 'announcement_attachments',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.announcementAttachment.create({
        data: {
          id,
          tenantId: own.tenantId,
          announcementId: link.announcementId,
          fileId: await communityFileRow(tx, own.tenantId),
          uploadedById: own.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'announcement_read_marks',
    key: 'announcement_id',
    insert: async (tx, own, link) => {
      // One mark per announcement here: the row is found by it.
      const announcementId = await parent(own, link, link.announcementId, () =>
        announcementRow(tx, {
          tenantId: own.tenantId,
          createdById: own.accountId,
        }),
      );
      await tx.announcementReadMark.create({
        data: {
          tenantId: own.tenantId,
          announcementId,
          kind: 'account',
          ref: new Uint8Array(randomBytes(32)),
        },
      });
      return announcementId;
    },
  },
  {
    table: 'community_events',
    insert: (tx, own, link) =>
      eventRow(tx, { tenantId: own.tenantId, createdById: link.accountId }),
  },
  {
    table: 'event_attachments',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.eventAttachment.create({
        data: {
          id,
          tenantId: own.tenantId,
          eventId: link.eventId,
          fileId: await communityFileRow(tx, own.tenantId),
          uploadedById: own.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'event_rsvps',
    insert: async (tx, own, link) => {
      const id = newId();
      // One answer per account and event: each row has an event of its own.
      const eventId = await parent(own, link, link.eventId, () =>
        eventRow(tx, { tenantId: own.tenantId, createdById: own.accountId }),
      );
      await tx.eventRsvp.create({
        data: {
          id,
          tenantId: own.tenantId,
          eventId,
          accountId: own.accountId,
          unitId: own.unitId,
          response: 'going',
        },
      });
      return id;
    },
  },
  {
    table: 'polls',
    insert: (tx, own, link) =>
      pollRow(tx, { tenantId: own.tenantId, createdById: link.accountId }),
  },
  {
    table: 'poll_options',
    insert: async (tx, own, link) => {
      const id = newId();
      // Positions are unique in a poll: each row has a poll of its own.
      const pollId = await parent(own, link, link.pollId, () =>
        pollRow(tx, { tenantId: own.tenantId, createdById: own.accountId }),
      );
      await tx.pollOption.create({
        data: {
          id,
          tenantId: own.tenantId,
          pollId,
          position: 1,
          labelEn: 'Yes',
        },
      });
      return id;
    },
  },
  {
    table: 'poll_ballot_boxes',
    key: 'poll_id',
    insert: async (tx, own, link) => {
      const pollId = await parent(own, link, link.pollId, () =>
        pollRow(tx, { tenantId: own.tenantId, createdById: own.accountId }),
      );
      await tx.pollBallotBox.create({
        data: { tenantId: own.tenantId, pollId },
      });
      return pollId;
    },
  },
  {
    table: 'poll_participations',
    key: 'poll_id',
    insert: async (tx, own, link) => {
      const pollId = await parent(own, link, link.pollId, () =>
        pollRow(tx, { tenantId: own.tenantId, createdById: own.accountId }),
      );
      await tx.pollParticipation.create({
        data: { tenantId: own.tenantId, pollId, unitId: own.unitId },
      });
      return pollId;
    },
  },
  {
    table: 'suggestions',
    insert: (tx, own, link) =>
      suggestionRow(tx, {
        tenantId: own.tenantId,
        authorId: own.accountId,
        topicId: link.topicId,
      }),
  },
  {
    table: 'suggestion_updates',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.suggestionUpdate.create({
        data: {
          id,
          tenantId: own.tenantId,
          suggestionId: link.suggestionId,
          status: 'under_review',
          byId: own.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'suggestion_attachments',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.suggestionAttachment.create({
        data: {
          id,
          tenantId: own.tenantId,
          suggestionId: link.suggestionId,
          fileId: await communityFileRow(tx, own.tenantId),
          uploadedById: own.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'suggestion_supports',
    key: 'suggestion_id',
    insert: async (tx, own, link) => {
      // One support per account and suggestion: a suggestion of its own.
      const suggestionId = await parent(own, link, link.suggestionId, () =>
        suggestionRow(tx, {
          tenantId: own.tenantId,
          authorId: own.accountId,
          topicId: own.topicId,
        }),
      );
      await tx.suggestionSupport.create({
        data: {
          tenantId: own.tenantId,
          suggestionId,
          accountId: own.accountId,
        },
      });
      return suggestionId;
    },
  },
];

describe('RLS isolation — community life tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Engagement ${label}`);
    const unit = await createUnit(h, tenantId);
    const account = await createAccountRow(h, tenantId);
    const s: Side = {
      tenantId,
      unitId: unit.id,
      accountId: account.id,
      topicId: '',
      announcementId: '',
      eventId: '',
      pollId: '',
      suggestionId: '',
    };
    await inTenant(s, async (tx) => {
      const by = { tenantId, createdById: s.accountId };
      s.topicId = await suggestionTopicRow(tx, tenantId);
      s.announcementId = await announcementRow(tx, by);
      s.eventId = await eventRow(tx, by);
      s.pollId = await pollRow(tx, by);
      s.suggestionId = await suggestionRow(tx, {
        tenantId,
        authorId: s.accountId,
        topicId: s.topicId,
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
      // Where the app has no UPDATE or no DELETE, or a trigger keeps the
      // row as it is, that is nothing too.
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
