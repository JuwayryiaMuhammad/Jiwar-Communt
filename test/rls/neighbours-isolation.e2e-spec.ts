import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  categoryRow,
  claimRow,
  complaintMessageRow,
  complaintRow,
  conversationMessageRow,
  conversationRow,
  neighbourFileRow,
  noticeRow,
  occupancyRow,
  postRow,
  reportRow,
  statusChangeRow,
} from '../setup/neighbours-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  otherUnitId: string;
  accountId: string;
  otherAccountId: string;
  categoryId: string;
  complaintId: string;
  messageId: string;
  noticeId: string;
  postId: string;
  claimId: string;
  conversationId: string;
}

/**
 * One neighbours table: how to insert a row in a compound. `link` points
 * the row's foreign keys at another compound's rows, which the composite
 * keys must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** The column the row is found by (`id` unless the table has none). */
  key?: string;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

/** A complaint of the compound's own when the row is not being linked across. */
const freshComplaint = (tx: TenantTxClient, own: Side, link: Side) =>
  own === link
    ? complaintRow(tx, {
        tenantId: own.tenantId,
        authorId: own.accountId,
        targetUnitId: own.otherUnitId,
        categoryId: own.categoryId,
      })
    : Promise.resolve(link.complaintId);

const freshPost = (tx: TenantTxClient, own: Side, link: Side) =>
  own === link
    ? postRow(tx, { tenantId: own.tenantId, authorId: own.accountId })
    : Promise.resolve(link.postId);

/**
 * The neighbours tables (ADR 0042): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'neighbour_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.neighbourSettings.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'neighbour_complaint_counters',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.neighbourComplaintCounter.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'neighbour_welcome_templates',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.neighbourWelcomeTemplate.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'neighbour_complaint_categories',
    linked: false,
    insert: (tx, own) => categoryRow(tx, own.tenantId),
  },
  {
    table: 'neighbour_complaints',
    insert: (tx, own, link) =>
      complaintRow(tx, {
        tenantId: own.tenantId,
        authorId: own.accountId,
        targetUnitId: link.otherUnitId,
        categoryId: own.categoryId,
      }),
  },
  {
    table: 'neighbour_complaint_status_history',
    insert: (tx, own, link) =>
      statusChangeRow(tx, {
        tenantId: own.tenantId,
        complaintId: link.complaintId,
        actorId: own.accountId,
      }),
  },
  {
    table: 'neighbour_complaint_messages',
    insert: (tx, own, link) =>
      complaintMessageRow(tx, {
        tenantId: own.tenantId,
        complaintId: link.complaintId,
        senderId: own.accountId,
      }),
  },
  {
    table: 'neighbour_complaint_attachments',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.neighbourComplaintAttachment.create({
        data: {
          id,
          tenantId: own.tenantId,
          complaintId: link.complaintId,
          messageId: link.messageId,
          fileId: await neighbourFileRow(tx, own.tenantId),
          uploadedById: own.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'neighbour_complaint_notices',
    insert: async (tx, own, link) =>
      noticeRow(tx, {
        tenantId: own.tenantId,
        // One notice per complaint: a complaint of its own.
        complaintId: await freshComplaint(tx, own, link),
        sentById: own.accountId,
      }),
  },
  {
    table: 'neighbour_complaint_notice_recipients',
    key: 'notice_id',
    insert: async (tx, own, link) => {
      // One row per notice and account: a notice of its own.
      const noticeId =
        own === link
          ? await noticeRow(tx, {
              tenantId: own.tenantId,
              complaintId: await freshComplaint(tx, own, link),
              sentById: own.accountId,
            })
          : link.noticeId;
      await tx.neighbourComplaintNoticeRecipient.create({
        data: { tenantId: own.tenantId, noticeId, accountId: own.accountId },
      });
      return noticeId;
    },
  },
  {
    table: 'neighbour_posts',
    insert: (tx, own, link) =>
      postRow(tx, {
        tenantId: own.tenantId,
        authorId: own.accountId,
        authorUnitId: link.unitId,
      }),
  },
  {
    table: 'neighbour_post_photos',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.neighbourPostPhoto.create({
        data: {
          id,
          tenantId: own.tenantId,
          postId: link.postId,
          fileId: await neighbourFileRow(
            tx,
            own.tenantId,
            'neighbour_post_photo',
          ),
        },
      });
      return id;
    },
  },
  {
    table: 'neighbour_item_claims',
    insert: async (tx, own, link) =>
      claimRow(tx, {
        tenantId: own.tenantId,
        // One pending claim per person and post: a post of its own.
        postId: await freshPost(tx, own, link),
        claimantId: own.otherAccountId,
      }),
  },
  {
    table: 'neighbour_item_handovers',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.neighbourItemHandover.create({
        data: {
          id,
          tenantId: own.tenantId,
          // One handover per post: a post of its own.
          postId: await freshPost(tx, own, link),
          recipientId: own.otherAccountId,
          handedById: own.accountId,
        },
      });
      return id;
    },
  },
  {
    table: 'neighbour_conversations',
    insert: async (tx, own, link) =>
      conversationRow(tx, {
        tenantId: own.tenantId,
        // One conversation per post and responder: a post of its own.
        postId: await freshPost(tx, own, link),
        authorId: own.accountId,
        responderId: own.otherAccountId,
      }),
  },
  {
    table: 'neighbour_conversation_messages',
    insert: (tx, own, link) =>
      conversationMessageRow(tx, {
        tenantId: own.tenantId,
        conversationId: link.conversationId,
        senderId: own.accountId,
      }),
  },
  {
    table: 'neighbour_blocks',
    insert: async (tx, own, link) => {
      const id = newId();
      // One block per pair and direction: each insert a new direction.
      const taken = await tx.neighbourBlock.count({
        where: { blockerId: own.accountId, blockedId: own.otherAccountId },
      });
      await tx.neighbourBlock.create({
        data: {
          id,
          tenantId: own.tenantId,
          blockerId: taken ? own.otherAccountId : own.accountId,
          blockedId: taken ? own.accountId : own.otherAccountId,
          conversationId: link.conversationId,
        },
      });
      return id;
    },
  },
  {
    table: 'neighbour_conversation_reports',
    insert: async (tx, own, link) => {
      // One report per reporter and conversation: a conversation of its own.
      const conversationId =
        own === link
          ? await conversationRow(tx, {
              tenantId: own.tenantId,
              postId: await freshPost(tx, own, link),
              authorId: own.accountId,
              responderId: own.otherAccountId,
            })
          : link.conversationId;
      return reportRow(tx, {
        tenantId: own.tenantId,
        conversationId,
        reporterId: own.accountId,
      });
    },
  },
  {
    table: 'neighbour_welcomes',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.neighbourWelcome.create({
        data: {
          id,
          tenantId: own.tenantId,
          occupancyId: await occupancyRow(tx, {
            tenantId: own.tenantId,
            unitId: own.unitId,
            accountId: own.accountId,
          }),
          unitId: link.unitId,
          accountId: own.accountId,
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — neighbours tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Neighbours ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      otherUnitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      otherAccountId: (await createAccountRow(h, tenantId)).id,
      categoryId: '',
      complaintId: '',
      messageId: '',
      noticeId: '',
      postId: '',
      claimId: '',
      conversationId: '',
    };
    await inTenant(s, async (tx) => {
      s.categoryId = await categoryRow(tx, tenantId);
      s.complaintId = await complaintRow(tx, {
        tenantId,
        authorId: s.accountId,
        targetUnitId: s.otherUnitId,
        categoryId: s.categoryId,
      });
      s.messageId = await complaintMessageRow(tx, {
        tenantId,
        complaintId: s.complaintId,
        senderId: s.accountId,
      });
      s.noticeId = await noticeRow(tx, {
        tenantId,
        complaintId: s.complaintId,
        sentById: s.accountId,
      });
      s.postId = await postRow(tx, { tenantId, authorId: s.accountId });
      s.claimId = await claimRow(tx, {
        tenantId,
        postId: s.postId,
        claimantId: s.otherAccountId,
      });
      s.conversationId = await conversationRow(tx, {
        tenantId,
        postId: s.postId,
        authorId: s.accountId,
        responderId: s.otherAccountId,
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
