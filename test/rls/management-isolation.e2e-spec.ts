import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  attachmentFileRow,
  decisionAppealRow,
  messageRow,
  requestRow,
  topicRow,
} from '../setup/management-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  topicId: string;
  requestId: string;
  messageId: string;
  appealId: string;
}

/**
 * One management table: how to insert a row in a compound. `link` points
 * the row's foreign keys at another compound's rows, which the composite
 * keys must refuse.
 */
interface Table {
  table: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** The column the row is found by (`id` unless the key is the tenant). */
  key?: string;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
}

let slots = 0;

/**
 * Management tables (ADR 0039): isolated like every other tenant table,
 * linked with composite keys. The RLS coverage test checks the policies
 * exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'management_request_topics',
    linked: false,
    insert: (tx, own) => topicRow(tx, own.tenantId),
  },
  {
    table: 'management_request_settings',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.managementRequestSettings.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'management_request_counters',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.managementRequestCounter.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'management_office_hours',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      // A minute of its own: the window's start is unique in a weekday.
      const startMinute = 1 + (slots++ % 500);
      await tx.managementOfficeHours.create({
        data: {
          id,
          tenantId: own.tenantId,
          weekday: 5,
          startMinute,
          endMinute: startMinute + 1,
        },
      });
      return id;
    },
  },
  {
    table: 'management_requests',
    insert: (tx, own, link) =>
      requestRow(tx, {
        tenantId: own.tenantId,
        topicId: link.topicId,
        authorId: link.accountId,
      }),
  },
  {
    table: 'management_request_messages',
    insert: (tx, own, link) =>
      messageRow(tx, {
        tenantId: own.tenantId,
        requestId: link.requestId,
        senderId: link.accountId,
      }),
  },
  {
    table: 'management_request_attachments',
    insert: async (tx, own, link) => {
      const id = newId();
      // The file is the row's own; the message and its request are linked.
      const fileId = await attachmentFileRow(tx, own.tenantId);
      await tx.managementRequestAttachment.create({
        data: {
          id,
          tenantId: own.tenantId,
          requestId: link.requestId,
          messageId: link.messageId,
          fileId,
          uploadedById: own.accountId,
        },
      });
      return id;
    },
  },
  {
    // Append-only and without foreign keys, like ticket_escalations.
    table: 'management_request_escalations',
    linked: false,
    insert: async (tx, own) => {
      const id = newId();
      await tx.managementRequestEscalation.create({
        data: {
          id,
          tenantId: own.tenantId,
          requestId: newId(),
          cycle: 1,
          dueAt: new Date(),
        },
      });
      return id;
    },
  },
  {
    table: 'management_request_ratings',
    key: 'request_id',
    insert: async (tx, own, link) => {
      // One rating per request: each row rates a request of its own.
      const requestId =
        own === link
          ? await requestRow(tx, {
              tenantId: own.tenantId,
              topicId: own.topicId,
              authorId: own.accountId,
            })
          : link.requestId;
      await tx.managementRequestRating.create({
        data: {
          tenantId: own.tenantId,
          requestId,
          authorId: own.accountId,
          rating: 5,
        },
      });
      return requestId;
    },
  },
  {
    table: 'management_appointments',
    insert: async (tx, own, link) => {
      const id = newId();
      // One live appointment per request: each row has a request of its own.
      const requestId =
        own === link
          ? await requestRow(tx, {
              tenantId: own.tenantId,
              topicId: own.topicId,
              authorId: own.accountId,
            })
          : link.requestId;
      const startsAt = new Date(Date.UTC(2031, 0, 1, 9, slots++));
      await tx.managementAppointment.create({
        data: {
          id,
          tenantId: own.tenantId,
          requestId,
          status: 'requested',
          mode: 'in_person',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 1_800_000),
          proposedBySide: 'resident',
          proposedById: own.accountId,
        },
      });
      return id;
    },
  },
  // Decision appeals (ADR 0059).
  {
    table: 'decision_appeal_counters',
    key: 'tenant_id',
    linked: false,
    insert: async (tx, own) => {
      await tx.decisionAppealCounter.upsert({
        where: { tenantId: own.tenantId },
        create: { tenantId: own.tenantId },
        update: {},
      });
      return own.tenantId;
    },
  },
  {
    table: 'decision_appeals',
    insert: (tx, own, link) =>
      decisionAppealRow(tx, {
        tenantId: own.tenantId,
        unitId: link.unitId,
        appellantId: link.accountId,
      }),
  },
  {
    table: 'decision_appeal_attachments',
    key: 'file_id',
    insert: async (tx, own, link) => {
      // The file is the row's own; the appeal is linked.
      const fileId = await attachmentFileRow(tx, own.tenantId);
      await tx.decisionAppealAttachment.create({
        data: {
          tenantId: own.tenantId,
          appealId: link.appealId,
          fileId,
          position: 1 + (slots++ % 3),
        },
      });
      return fileId;
    },
  },
];

describe('RLS isolation — management tables', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(
    s: { tenantId: string },
    fn: (tx: TenantTxClient) => Promise<T>,
  ) => h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Management ${label}`);
    const unit = await createUnit(h, tenantId);
    const account = await createAccountRow(h, tenantId);
    const s: Side = {
      tenantId,
      unitId: unit.id,
      accountId: account.id,
      topicId: '',
      requestId: '',
      messageId: '',
      appealId: '',
    };
    await inTenant(s, async (tx) => {
      s.topicId = await topicRow(tx, tenantId);
      s.requestId = await requestRow(tx, {
        tenantId,
        topicId: s.topicId,
        authorId: s.accountId,
      });
      s.messageId = await messageRow(tx, {
        tenantId,
        requestId: s.requestId,
        senderId: s.accountId,
      });
      s.appealId = await decisionAppealRow(tx, {
        tenantId,
        unitId: s.unitId,
        appellantId: s.accountId,
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

  it('the appointment slot locks are isolated too', async () => {
    const startsAt = new Date(Date.UTC(2031, 5, 1, 9));
    await inTenant(a, (tx) =>
      tx.managementAppointmentSlot.create({
        data: { tenantId: a.tenantId, startsAt },
      }),
    );
    const seen = (s: Side) =>
      inTenant(s, (tx) =>
        tx.managementAppointmentSlot.count({ where: { startsAt } }),
      );
    expect(await seen(a)).toBe(1);
    expect(await seen(b)).toBe(0);
    await expect(
      inTenant(b, (tx) =>
        tx.managementAppointmentSlot.create({
          data: {
            tenantId: a.tenantId,
            startsAt: new Date(startsAt.getTime() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

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
      // Where the app has no UPDATE or no DELETE, that is nothing too.
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
