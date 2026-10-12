import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import {
  attachmentFileRow,
  messageRow,
  requestRow,
  topicRow,
} from '../setup/management-rows';
import { required } from '../setup/test-env';

/**
 * ADR 0039: a request's conversation never changes. Attachments and
 * escalations are append-only like the ticket histories (ADR 0032). A
 * message and a rating take exactly one change, the one an erasure makes:
 * the free text cleared, nothing else touched. For the app and for the
 * table's owner alike.
 */
describe('management request history is immutable', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let requestId: string;
  let messageId: string;
  let attachmentId: string;
  let escalationId: string;

  const inTenant = <T>(fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(tenantId, () => h.tenantTx.withTenantTx(fn));

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Management immutability');
    accountId = (await createAccountRow(h, tenantId)).id;
    await inTenant(async (tx) => {
      const topicId = await topicRow(tx, tenantId);
      requestId = await requestRow(tx, {
        tenantId,
        topicId,
        authorId: accountId,
      });
      messageId = await messageRow(tx, {
        tenantId,
        requestId,
        senderId: accountId,
      });
      attachmentId = newId();
      await tx.managementRequestAttachment.create({
        data: {
          id: attachmentId,
          tenantId,
          requestId,
          messageId,
          fileId: await attachmentFileRow(tx, tenantId),
          uploadedById: accountId,
        },
      });
      escalationId = newId();
      await tx.managementRequestEscalation.create({
        data: {
          id: escalationId,
          tenantId,
          requestId,
          cycle: 1,
          dueAt: new Date(),
        },
      });
      await tx.managementRequestRating.create({
        data: {
          tenantId,
          requestId,
          authorId: accountId,
          rating: 4,
          comment: 'Fine',
        },
      });
    });
    app = new Client({ connectionString: process.env.DATABASE_URL });
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await app.connect();
    await migrator.connect();
  });

  afterAll(async () => {
    await app.end();
    await migrator.end();
    await h.close();
  });

  /** Runs `sql` as `client` inside the tenant, rolled back afterwards. */
  async function attempt(client: Client, sql: string) {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      return await client.query(sql);
    } finally {
      await client.query('ROLLBACK');
    }
  }

  const privileges = async (table: string) => {
    const { rows } = await app.query<Record<string, boolean>>(
      `SELECT has_table_privilege($1, 'SELECT') AS select,
              has_table_privilege($1, 'INSERT') AS insert,
              has_table_privilege($1, 'UPDATE') AS update,
              has_table_privilege($1, 'DELETE') AS delete,
              has_table_privilege($1, 'TRUNCATE') AS truncate`,
      [table],
    );
    return rows[0];
  };

  describe.each([
    [
      'management_request_attachments',
      () => attachmentId,
      'created_at = now()',
    ],
    ['management_request_escalations', () => escalationId, 'cycle = 2'],
  ])('%s is append-only', (table, id, change) => {
    const update = () => `UPDATE ${table} SET ${change} WHERE id = '${id()}'`;
    const remove = () => `DELETE FROM ${table} WHERE id = '${id()}'`;
    const truncate = () => `TRUNCATE ${table}`;

    it('jiwar_app has only SELECT and INSERT', async () => {
      expect(await privileges(table)).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
    });

    it.each([
      ['UPDATE', update],
      ['DELETE', remove],
      ['TRUNCATE', truncate],
    ])('jiwar_app: %s is rejected', async (_op, sql) => {
      await expect(attempt(app, sql())).rejects.toThrow(/permission denied/);
    });

    it.each([
      ['UPDATE', update],
      ['DELETE', remove],
      ['TRUNCATE', truncate],
    ])(
      'jiwar_migrator (the owner): %s is rejected by the trigger',
      async (_op, sql) => {
        await expect(attempt(migrator, sql())).rejects.toThrow(
          new RegExp(`${table} is append-only`),
        );
      },
    );

    it('jiwar_app cannot disable the trigger', async () => {
      await expect(
        app.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`),
      ).rejects.toThrow(/must be owner/);
    });
  });

  describe('management_request_messages', () => {
    const table = 'management_request_messages';
    const set = (change: string) =>
      `UPDATE ${table} SET ${change} WHERE id = '${messageId}'`;
    const NEVER = /a management request message never changes/;

    it('jiwar_app has SELECT, INSERT and UPDATE, never DELETE or TRUNCATE', async () => {
      expect(await privileges(table)).toEqual({
        select: true,
        insert: true,
        update: true,
        delete: false,
        truncate: false,
      });
    });

    it.each([
      ['the body rewritten', `body = 'Edited'`],
      ['the official flag', `official = true, sender_side = 'staff'`],
      ['the internal flag', `internal = true, sender_side = 'staff'`],
      ['the sender', `sender_account_id = '${newId()}'`],
      ['the side', `sender_side = 'staff'`],
      ['the request', `request_id = '${newId()}'`],
      ['the cycle', `cycle = 2`],
      ['the time', `created_at = now()`],
      // An "erasure" that also changes something else is not an erasure.
      [
        'an erasure with a flag',
        `body = NULL, erased_at = now(), official = true, sender_side = 'staff'`,
      ],
    ])(
      '%s is refused, for the app and for the owner',
      async (_what, change) => {
        await expect(attempt(app, set(change))).rejects.toThrow(NEVER);
        await expect(attempt(migrator, set(change))).rejects.toThrow(NEVER);
      },
    );

    it('a body cleared without its time is refused', async () => {
      await expect(attempt(app, set(`body = NULL`))).rejects.toThrow(NEVER);
    });

    it('the erasure is the one change that passes, once', async () => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        const first = await app.query(set(`body = NULL, erased_at = now()`));
        expect(first.rowCount).toBe(1);
        // Erased is final: not written back, not erased again.
        await app.query('SAVEPOINT s');
        await expect(
          app.query(set(`body = 'Back', erased_at = NULL`)),
        ).rejects.toThrow(NEVER);
        await app.query('ROLLBACK TO SAVEPOINT s');
        await expect(app.query(set(`erased_at = now()`))).rejects.toThrow(
          NEVER,
        );
      } finally {
        await app.query('ROLLBACK');
      }
    });

    it.each([
      ['DELETE', `DELETE FROM ${table}`],
      ['TRUNCATE', `TRUNCATE ${table} CASCADE`],
    ])(
      '%s is refused: no privilege for the app, the trigger for the owner',
      async (_op, sql) => {
        await expect(attempt(app, sql)).rejects.toThrow(/permission denied/);
        // CASCADE reaches the attachments, whose trigger may answer first.
        await expect(attempt(migrator, sql)).rejects.toThrow(/is append-only/);
      },
    );

    it('jiwar_app cannot disable the triggers', async () => {
      await expect(
        app.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`),
      ).rejects.toThrow(/must be owner/);
    });
  });

  describe('management_request_ratings', () => {
    const table = 'management_request_ratings';
    const set = (change: string) =>
      `UPDATE ${table} SET ${change} WHERE request_id = '${requestId}'`;
    const NEVER = /a management request rating never changes/;

    it.each([
      ['the rating', `rating = 1`],
      ['the comment rewritten', `comment = 'Better'`],
      ['the author', `author_account_id = '${newId()}'`],
      ['the time', `created_at = now()`],
      ['an erasure with a new rating', `comment = NULL, rating = 1`],
    ])(
      '%s is refused, for the app and for the owner',
      async (_what, change) => {
        await expect(attempt(app, set(change))).rejects.toThrow(NEVER);
        await expect(attempt(migrator, set(change))).rejects.toThrow(NEVER);
      },
    );

    it('clearing the comment is the one change that passes, once', async () => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        expect((await app.query(set(`comment = NULL`))).rowCount).toBe(1);
        await expect(app.query(set(`comment = NULL`))).rejects.toThrow(NEVER);
      } finally {
        await app.query('ROLLBACK');
      }
    });

    it('a second rating of the request is refused by the primary key', async () => {
      await expect(
        attempt(
          app,
          `INSERT INTO ${table} (tenant_id, request_id, author_account_id, rating)
           VALUES ('${tenantId}', '${requestId}', '${accountId}', 5)`,
        ),
      ).rejects.toThrow(/management_request_ratings_pkey/);
    });

    it.each([
      ['DELETE', `DELETE FROM ${table}`],
      ['TRUNCATE', `TRUNCATE ${table}`],
    ])(
      '%s is refused: no privilege for the app, the trigger for the owner',
      async (_op, sql) => {
        await expect(attempt(app, sql)).rejects.toThrow(/permission denied/);
        await expect(attempt(migrator, sql)).rejects.toThrow(
          new RegExp(`${table} is append-only`),
        );
      },
    );
  });

  it('every row is still there, unchanged', async () => {
    const rows = await inTenant(async (tx) => ({
      message: await tx.managementRequestMessage.findUnique({
        where: { id: messageId },
        select: { body: true, erasedAt: true, official: true },
      }),
      rating: await tx.managementRequestRating.findUnique({
        where: { tenantId_requestId: { tenantId, requestId } },
        select: { rating: true, comment: true },
      }),
      attachments: await tx.managementRequestAttachment.count({
        where: { id: attachmentId },
      }),
      escalations: await tx.managementRequestEscalation.count({
        where: { id: escalationId },
      }),
    }));
    expect(rows).toEqual({
      message: { body: 'Hello', erasedAt: null, official: false },
      rating: { rating: 4, comment: 'Fine' },
      attachments: 1,
      escalations: 1,
    });
  });
});
