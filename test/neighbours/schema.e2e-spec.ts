import { Client } from 'pg';
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
import { required } from '../setup/test-env';

/**
 * ADR 0042: what the neighbours tables refuse by themselves, whatever the
 * service says: the CHECKs, the append-only histories, the one change a
 * message's or a post's words take, and the privileges the app holds.
 * Statements run as jiwar_app (and, for the triggers, as the tables' owner
 * too) inside a tenant; every attempt is rolled back.
 */
describe('Neighbours tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let alice: string;
  let bob: string;
  let homeA: string;
  let homeB: string;
  let categoryId: string;
  let complaintId: string;
  let historyId: string;
  let messageId: string;
  let attachmentId: string;
  let noticeId: string;
  let postId: string;
  let photoId: string;
  let claimId: string;
  let handoverPostId: string;
  let conversationId: string;
  let conversationMessageId: string;
  let blockId: string;
  let reportId: string;
  let welcomeId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Neighbours schema');
    alice = (await createAccountRow(h, tenantId)).id;
    bob = (await createAccountRow(h, tenantId)).id;
    homeA = (await createUnit(h, tenantId)).id;
    homeB = (await createUnit(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        categoryId = await categoryRow(tx, tenantId);
        complaintId = await complaintRow(tx, {
          tenantId,
          authorId: alice,
          authorUnitId: homeA,
          targetUnitId: homeB,
          categoryId,
        });
        historyId = await statusChangeRow(tx, {
          tenantId,
          complaintId,
          actorId: alice,
        });
        messageId = await complaintMessageRow(tx, {
          tenantId,
          complaintId,
          senderId: alice,
        });
        attachmentId = newId();
        await tx.neighbourComplaintAttachment.create({
          data: {
            id: attachmentId,
            tenantId,
            complaintId,
            messageId,
            fileId: await neighbourFileRow(tx, tenantId),
            uploadedById: alice,
          },
        });
        noticeId = await noticeRow(tx, {
          tenantId,
          complaintId,
          sentById: bob,
        });
        await tx.neighbourComplaintNoticeRecipient.create({
          data: { tenantId, noticeId, accountId: bob },
        });
        postId = await postRow(tx, {
          tenantId,
          authorId: alice,
          authorUnitId: homeA,
        });
        photoId = newId();
        await tx.neighbourPostPhoto.create({
          data: {
            id: photoId,
            tenantId,
            postId,
            fileId: await neighbourFileRow(
              tx,
              tenantId,
              'neighbour_post_photo',
            ),
          },
        });
        claimId = await claimRow(tx, { tenantId, postId, claimantId: bob });
        handoverPostId = await postRow(tx, { tenantId, authorId: alice });
        await tx.neighbourItemHandover.create({
          data: {
            id: newId(),
            tenantId,
            postId: handoverPostId,
            recipientId: bob,
            handedById: alice,
          },
        });
        conversationId = await conversationRow(tx, {
          tenantId,
          postId,
          authorId: alice,
          responderId: bob,
          responderUnitId: homeB,
        });
        conversationMessageId = await conversationMessageRow(tx, {
          tenantId,
          conversationId,
          senderId: bob,
        });
        blockId = newId();
        await tx.neighbourBlock.create({
          data: {
            id: blockId,
            tenantId,
            blockerId: alice,
            blockedId: bob,
            conversationId,
          },
        });
        reportId = await reportRow(tx, {
          tenantId,
          conversationId,
          reporterId: alice,
        });
        welcomeId = newId();
        await tx.neighbourWelcome.create({
          data: {
            id: welcomeId,
            tenantId,
            occupancyId: await occupancyRow(tx, {
              tenantId,
              unitId: homeA,
              accountId: alice,
            }),
            unitId: homeA,
            accountId: alice,
          },
        });
      }),
    );
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

  /** Runs the statements as `client` inside the tenant, always rolled back. */
  async function attempt(client: Client, ...statements: string[]) {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      let last;
      for (const sql of statements) last = await client.query(sql);
      return last;
    } finally {
      await client.query('ROLLBACK');
    }
  }
  const asApp = (...statements: string[]) => attempt(app, ...statements);
  const set = (table: string, id: () => string, key = 'id') => {
    return (assignments: string) =>
      asApp(`UPDATE ${table} SET ${assignments} WHERE ${key} = '${id()}'`);
  };

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

  describe('settings, categories and the welcome template', () => {
    it('each limit stays inside its range', async () => {
      const settings = set('neighbour_settings', () => tenantId, 'tenant_id');
      for (const assignment of [
        'max_open_complaints = 0',
        'max_open_complaints = 51',
        'lost_found_expiry_days = 181',
        'lending_expiry_days = 0',
        'max_open_posts = 51',
        'max_new_conversations_per_day = 101',
      ])
        await expect(settings(assignment)).rejects.toThrow(
          /neighbour_settings_ranges/,
        );
      await settings(
        'max_open_complaints = 50, lost_found_expiry_days = 180, lending_expiry_days = 90',
      );
    });

    it('a category has a lowercase key and both names', async () => {
      const category = set('neighbour_complaint_categories', () => categoryId);
      await expect(category(`key = 'Noise!'`)).rejects.toThrow(
        /neighbour_complaint_categories_key_shape/,
      );
      await expect(category(`name_ar = ''`)).rejects.toThrow(
        /neighbour_complaint_categories_names_length/,
      );
      await expect(category(`name_en = repeat('x', 81)`)).rejects.toThrow(
        /neighbour_complaint_categories_names_length/,
      );
    });

    it('the welcome is whole per language, and each text has its length', async () => {
      const template = set(
        'neighbour_welcome_templates',
        () => tenantId,
        'tenant_id',
      );
      await expect(template(`rules_en = 'Rules'`)).rejects.toThrow(
        /neighbour_welcome_templates_whole_per_language/,
      );
      await expect(
        template(`rules_ar = 'قواعد', office_hours_ar = 'مواعيد'`),
      ).rejects.toThrow(/neighbour_welcome_templates_whole_per_language/);
      const english = `rules_en = 'Rules', office_hours_en = '9 to 5', emergency_en = '122'`;
      await template(english);
      await expect(
        template(`${english}, emergency_en = repeat('x', 1001)`),
      ).rejects.toThrow(/neighbour_welcome_templates_text_length/);
      await expect(template(`${english}, rules_en = ''`)).rejects.toThrow(
        /neighbour_welcome_templates_text_length/,
      );
    });

    it('a counter never goes below zero', async () => {
      await expect(
        set(
          'neighbour_complaint_counters',
          () => tenantId,
          'tenant_id',
        )('last_number = -1'),
      ).rejects.toThrow(/neighbour_complaint_counters_not_negative/);
    });
  });

  describe('complaints', () => {
    const complaint = set('neighbour_complaints', () => complaintId);
    const closed = (reason: string, side = 'staff', status = 'dismissed') =>
      complaint(
        `status = '${status}', closed_at = now(), close_reason = '${reason}', closed_by_side = '${side}'`,
      );

    it('is numbered from one', async () => {
      await expect(
        asApp(
          `INSERT INTO neighbour_complaints (id, tenant_id, number, author_account_id, target_unit_id, category_id, last_activity_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', 0, '${alice}', '${homeB}', '${categoryId}', now(), now())`,
        ),
      ).rejects.toThrow(/neighbour_complaints_number_positive/);
    });

    it('is never against the unit it was filed from', async () => {
      await expect(
        asApp(
          `INSERT INTO neighbour_complaints (id, tenant_id, number, author_account_id, author_unit_id, target_unit_id, category_id, last_activity_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', 7777, '${alice}', '${homeA}', '${homeA}', '${categoryId}', now(), now())`,
        ),
      ).rejects.toThrow(/neighbour_complaints_not_own_unit/);
    });

    it('closed has its three facts, and open has none of them', async () => {
      await expect(complaint(`status = 'resolved'`)).rejects.toThrow(
        /neighbour_complaints_closed_shape/,
      );
      await expect(complaint(`closed_at = now()`)).rejects.toThrow(
        /neighbour_complaints_closed_shape/,
      );
      await expect(
        complaint(
          `status = 'dismissed', closed_at = now(), close_reason = 'unfounded'`,
        ),
      ).rejects.toThrow(/neighbour_complaints_closed_shape/);
      await closed('unfounded');
    });

    it('each ending has its own reasons: unfounded dismisses, never resolves', async () => {
      await expect(closed('unfounded', 'staff', 'resolved')).rejects.toThrow(
        /neighbour_complaints_close_reason/,
      );
      await expect(closed('complied')).rejects.toThrow(
        /neighbour_complaints_close_reason/,
      );
      await expect(closed('because')).rejects.toThrow(
        /neighbour_complaints_close_reason/,
      );
      await closed('complied', 'staff', 'resolved');
    });

    it('the author alone withdraws, and gives no other reason', async () => {
      await expect(closed('withdrawn', 'staff')).rejects.toThrow(
        /neighbour_complaints_close_reason_side/,
      );
      await expect(closed('unfounded', 'resident')).rejects.toThrow(
        /neighbour_complaints_close_reason_side/,
      );
      await closed('withdrawn', 'resident');
    });

    it.each([
      ['number', 'number = number + 1'],
      ['author', () => `author_account_id = '${bob}'`],
      ['own unit', 'author_unit_id = NULL'],
      [
        'target unit',
        () => `target_unit_id = '${homeA}', author_unit_id = NULL`,
      ],
      ['filing time', `created_at = created_at - interval '1 day'`],
    ])('keeps its %s, for the app and for the owner', async (_, change) => {
      const sql = `UPDATE neighbour_complaints SET ${typeof change === 'string' ? change : change()} WHERE id = '${complaintId}'`;
      for (const client of [app, migrator])
        await expect(attempt(client, sql)).rejects.toThrow(/keeps its parties/);
    });

    it('is never deleted', async () => {
      for (const client of [app, migrator])
        await expect(
          attempt(
            client,
            `DELETE FROM neighbour_complaints WHERE id = '${complaintId}'`,
          ),
        ).rejects.toThrow(/keeps its parties|permission denied/);
    });

    it('its history is a filing and then moves, with a reason on an end and only there', async () => {
      const row = (from: string, to: string, reason = 'NULL') =>
        asApp(
          `INSERT INTO neighbour_complaint_status_history (id, tenant_id, complaint_id, from_status, to_status, actor_account_id, actor_side, reason_code)
           VALUES ('${newId()}', '${tenantId}', '${complaintId}', ${from}, '${to}', '${alice}', 'staff', ${reason})`,
        );
      await expect(row('NULL', 'under_review')).rejects.toThrow(
        /neighbour_complaint_status_history_move/,
      );
      await expect(row(`'submitted'`, 'submitted')).rejects.toThrow(
        /neighbour_complaint_status_history_move/,
      );
      await expect(row(`'resolved'`, 'under_review')).rejects.toThrow(
        /neighbour_complaint_status_history_move/,
      );
      await expect(row(`'under_review'`, 'resolved')).rejects.toThrow(
        /neighbour_complaint_status_history_reason/,
      );
      await expect(
        row(`'submitted'`, 'under_review', `'complied'`),
      ).rejects.toThrow(/neighbour_complaint_status_history_reason/);
      await row(`'submitted'`, 'under_review');
      await row(`'under_review'`, 'resolved', `'complied'`);
    });

    it('a note is the staff’s; a message has words until it is erased', async () => {
      const message = (thread: string, side: string, body = `'Words'`) =>
        asApp(
          `INSERT INTO neighbour_complaint_messages (id, tenant_id, complaint_id, thread, sender_account_id, sender_side, body)
           VALUES ('${newId()}', '${tenantId}', '${complaintId}', '${thread}', '${alice}', '${side}', ${body})`,
        );
      await expect(message('internal', 'resident')).rejects.toThrow(
        /neighbour_complaint_messages_internal_is_staff/,
      );
      await message('internal', 'staff');
      await message('target', 'resident');
      await expect(message('complainant', 'resident', 'NULL')).rejects.toThrow(
        /neighbour_complaint_messages_erased_shape/,
      );
      await expect(message('complainant', 'resident', `''`)).rejects.toThrow(
        /neighbour_complaint_messages_body_length/,
      );
      await expect(
        message('complainant', 'resident', `repeat('x', 4001)`),
      ).rejects.toThrow(/neighbour_complaint_messages_body_length/);
    });

    it('a message takes one change: an erasure clears its body, once', async () => {
      const change = (assignments: string, client = app) =>
        attempt(
          client,
          `UPDATE neighbour_complaint_messages SET ${assignments} WHERE id = '${messageId}'`,
        );
      for (const client of [app, migrator]) {
        await expect(change(`body = 'Rewritten'`, client)).rejects.toThrow(
          /never changes/,
        );
        await expect(change(`thread = 'target'`, client)).rejects.toThrow(
          /never changes/,
        );
        await expect(
          change(
            `body = NULL, erased_at = now(), sender_account_id = '${bob}'`,
            client,
          ),
        ).rejects.toThrow(/never changes/);
        await expect(
          attempt(
            client,
            `DELETE FROM neighbour_complaint_messages WHERE id = '${messageId}'`,
          ),
        ).rejects.toThrow(/append-only|permission denied/);
      }
      const erased = await change(`body = NULL, erased_at = now()`);
      expect(erased!.rowCount).toBe(1);
      // Once: an erased message is not erased again, nor given words back.
      await expect(
        asApp(
          `UPDATE neighbour_complaint_messages SET body = NULL, erased_at = now() WHERE id = '${messageId}'`,
          `UPDATE neighbour_complaint_messages SET erased_at = now() WHERE id = '${messageId}'`,
        ),
      ).rejects.toThrow(/never changes/);
    });

    it('a notice has words, and a complaint has one notice', async () => {
      const complaintTwo = `'${newId()}'`;
      const seed = `INSERT INTO neighbour_complaints (id, tenant_id, number, author_account_id, target_unit_id, category_id, last_activity_at, updated_at)
        VALUES (${complaintTwo}, '${tenantId}', 8888, '${alice}', '${homeB}', '${categoryId}', now(), now())`;
      const notice = (complaint: string, body: string) =>
        `INSERT INTO neighbour_complaint_notices (id, tenant_id, complaint_id, body, recipient_kind, sent_by_account_id)
         VALUES ('${newId()}', '${tenantId}', ${complaint}, ${body}, 'owners', '${bob}')`;
      await expect(asApp(seed, notice(complaintTwo, `''`))).rejects.toThrow(
        /neighbour_complaint_notices_body_length/,
      );
      await expect(
        asApp(seed, notice(complaintTwo, `repeat('x', 2001)`)),
      ).rejects.toThrow(/neighbour_complaint_notices_body_length/);
      await asApp(seed, notice(complaintTwo, `'Please'`));
      await expect(
        asApp(notice(`'${complaintId}'`, `'A second one'`)),
      ).rejects.toThrow(/neighbour_complaint_notices_one_per_complaint/);
    });
  });

  describe('the boards', () => {
    const post = set('neighbour_posts', () => postId);
    const insert = (columns: string, values: string) =>
      asApp(
        `INSERT INTO neighbour_posts (id, tenant_id, author_account_id, expires_at, updated_at, ${columns})
         VALUES ('${newId()}', '${tenantId}', '${alice}', now() + interval '1 day', now(), ${values})`,
      );

    it('a post has words until its author is erased, and then neither words nor place', async () => {
      await expect(
        insert('kind, author_side, body', `'found', 'resident', NULL`),
      ).rejects.toThrow(/neighbour_posts_erased_shape/);
      await expect(
        insert(
          'kind, author_side, body, place, erased_at',
          `'found', 'resident', NULL, 'Gate 2', now()`,
        ),
      ).rejects.toThrow(/neighbour_posts_erased_shape/);
      await expect(
        insert('kind, author_side, body', `'found', 'resident', ''`),
      ).rejects.toThrow(/neighbour_posts_text_length/);
      await expect(
        insert(
          'kind, author_side, body, place',
          `'found', 'resident', 'Keys', repeat('x', 121)`,
        ),
      ).rejects.toThrow(/neighbour_posts_text_length/);
    });

    it('the staff post only what was lost or found, from no unit; only those have a day', async () => {
      await expect(
        insert('kind, author_side, body', `'lend', 'staff', 'A ladder'`),
      ).rejects.toThrow(/neighbour_posts_author_shape/);
      await expect(
        insert(
          'kind, author_side, body, author_unit_id',
          `'found', 'staff', 'Keys', '${homeA}'`,
        ),
      ).rejects.toThrow(/neighbour_posts_author_shape/);
      await expect(
        insert(
          'kind, author_side, body, occurred_on',
          `'borrow', 'resident', 'A drill', current_date`,
        ),
      ).rejects.toThrow(/neighbour_posts_author_shape/);
      await insert('kind, author_side, body', `'found', 'staff', 'Keys'`);
      await insert(
        'kind, author_side, body, occurred_on',
        `'lost', 'resident', 'A cat', current_date`,
      );
    });

    it('it leaves its board after it was written, never before', async () => {
      await expect(
        asApp(
          `INSERT INTO neighbour_posts (id, tenant_id, author_account_id, kind, author_side, body, expires_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${alice}', 'found', 'resident', 'Keys', now() - interval '1 day', now())`,
        ),
      ).rejects.toThrow(/neighbour_posts_expires_after_creation/);
    });

    it('closed has its time and its reason, from the list', async () => {
      await expect(post(`status = 'closed'`)).rejects.toThrow(
        /neighbour_posts_closed_shape/,
      );
      await expect(post(`close_reason = 'resolved'`)).rejects.toThrow(
        /neighbour_posts_closed_shape/,
      );
      await expect(
        post(`status = 'closed', closed_at = now(), close_reason = 'bored'`),
      ).rejects.toThrow(/neighbour_posts_closed_shape/);
      await post(
        `status = 'closed', closed_at = now(), close_reason = 'handed_over'`,
      );
    });

    it('a post keeps its author, kind and dates; its words go once, with its place', async () => {
      for (const client of [app, migrator]) {
        for (const change of [
          `author_account_id = '${bob}'`,
          `kind = 'lost'`,
          `expires_at = expires_at + interval '30 days'`,
          `body = 'Rewritten'`,
          `place = 'Elsewhere'`,
          // An erasure that keeps the place is not one.
          `body = NULL, erased_at = now()`,
        ])
          await expect(
            attempt(
              client,
              `UPDATE neighbour_posts SET ${change} WHERE id = '${postId}'`,
            ),
          ).rejects.toThrow(/keeps its author and its words/);
        await expect(
          attempt(client, `DELETE FROM neighbour_posts WHERE id = '${postId}'`),
        ).rejects.toThrow(/keeps its author|permission denied/);
      }
      const erased = await post(`body = NULL, place = NULL, erased_at = now()`);
      expect(erased!.rowCount).toBe(1);
    });

    it('a claim is pending or decided, and a declined one says why', async () => {
      const claim = set('neighbour_item_claims', () => claimId);
      await expect(claim(`status = 'handed_over'`)).rejects.toThrow(
        /neighbour_item_claims_decided_shape/,
      );
      await expect(
        claim(`status = 'declined', decided_at = now()`),
      ).rejects.toThrow(/neighbour_item_claims_decided_shape/);
      await expect(
        claim(`status = 'declined', decided_at = now(), decline_reason = 'no'`),
      ).rejects.toThrow(/neighbour_item_claims_decided_shape/);
      await expect(
        claim(
          `status = 'withdrawn', decided_at = now(), decline_reason = 'not_the_owner'`,
        ),
      ).rejects.toThrow(/neighbour_item_claims_decided_shape/);
      await claim(
        `status = 'declined', decided_at = now(), decline_reason = 'not_the_owner'`,
      );
      await expect(claim(`note = repeat('x', 501)`)).rejects.toThrow(
        /keeps its claimant|neighbour_item_claims_note_length/,
      );
      await expect(
        asApp(
          `INSERT INTO neighbour_item_claims (id, tenant_id, post_id, claimant_account_id, note, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${handoverPostId}', '${bob}', repeat('x', 501), now())`,
        ),
      ).rejects.toThrow(/neighbour_item_claims_note_length/);
    });

    it('a claim keeps its claimant and its post; its note is only ever cleared', async () => {
      const claim = set('neighbour_item_claims', () => claimId);
      await expect(claim(`claimant_account_id = '${alice}'`)).rejects.toThrow(
        /keeps its claimant/,
      );
      await expect(claim(`note = 'Rewritten'`)).rejects.toThrow(
        /keeps its claimant/,
      );
      await claim(`note = NULL`);
      // One pending claim per person and post.
      await expect(
        asApp(
          `INSERT INTO neighbour_item_claims (id, tenant_id, post_id, claimant_account_id, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${postId}', '${bob}', now())`,
        ),
      ).rejects.toThrow(/neighbour_item_claims_one_pending/);
    });

    it('an item is handed over once', async () => {
      await expect(
        asApp(
          `INSERT INTO neighbour_item_handovers (id, tenant_id, post_id, recipient_account_id, handed_by_account_id)
           VALUES ('${newId()}', '${tenantId}', '${handoverPostId}', '${bob}', '${alice}')`,
        ),
      ).rejects.toThrow(/neighbour_item_handovers_one_per_post/);
    });
  });

  describe('masked contact', () => {
    const conversation = set('neighbour_conversations', () => conversationId);

    it('a conversation is between two people, one per post and responder', async () => {
      const insert = (responder: string) =>
        asApp(
          `INSERT INTO neighbour_conversations (id, tenant_id, post_id, author_account_id, responder_account_id, last_message_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${postId}', '${alice}', '${responder}', now(), now())`,
        );
      await expect(insert(alice)).rejects.toThrow(
        /neighbour_conversations_two_people/,
      );
      await expect(insert(bob)).rejects.toThrow(
        /neighbour_conversations_one_per_responder/,
      );
    });

    it('closed has its time and its reason, from the system’s list', async () => {
      await expect(conversation(`closed_at = now()`)).rejects.toThrow(
        /neighbour_conversations_closed_shape/,
      );
      await expect(
        conversation(`closed_at = now(), close_reason = 'rude'`),
      ).rejects.toThrow(/neighbour_conversations_closed_shape/);
      await conversation(`closed_at = now(), close_reason = 'blocked'`);
    });

    it('it keeps its parties; names once shown stay shown; closed stays closed', async () => {
      for (const client of [app, migrator]) {
        const change = (...statements: string[]) =>
          attempt(
            client,
            ...statements.map(
              (s) =>
                `UPDATE neighbour_conversations SET ${s} WHERE id = '${conversationId}'`,
            ),
          );
        await expect(
          change(`responder_account_id = '${alice}'`),
        ).rejects.toThrow(/keeps its parties|two_people/);
        await expect(change(`responder_unit_id = NULL`)).rejects.toThrow(
          /keeps its parties/,
        );
        // One side agreed: it may still take it back.
        await change(`author_reveal_at = now()`, `author_reveal_at = NULL`);
        // Both agreed: neither does.
        await expect(
          change(
            `author_reveal_at = now(), responder_reveal_at = now()`,
            `author_reveal_at = NULL`,
          ),
        ).rejects.toThrow(/keeps its parties, its names and its end/);
        await expect(
          change(
            `closed_at = now(), close_reason = 'reported'`,
            `closed_at = NULL, close_reason = NULL`,
          ),
        ).rejects.toThrow(/keeps its parties, its names and its end/);
        await expect(
          attempt(
            client,
            `DELETE FROM neighbour_conversations WHERE id = '${conversationId}'`,
          ),
        ).rejects.toThrow(/keeps its parties|permission denied/);
      }
    });

    it('a message has words until it is erased, and takes that one change', async () => {
      const insert = (body: string) =>
        asApp(
          `INSERT INTO neighbour_conversation_messages (id, tenant_id, conversation_id, sender_account_id, body)
           VALUES ('${newId()}', '${tenantId}', '${conversationId}', '${bob}', ${body})`,
        );
      await expect(insert('NULL')).rejects.toThrow(
        /neighbour_conversation_messages_erased_shape/,
      );
      await expect(insert(`repeat('x', 2001)`)).rejects.toThrow(
        /neighbour_conversation_messages_body_length/,
      );
      const change = (assignments: string, client = app) =>
        attempt(
          client,
          `UPDATE neighbour_conversation_messages SET ${assignments} WHERE id = '${conversationMessageId}'`,
        );
      for (const client of [app, migrator]) {
        await expect(change(`body = 'Rewritten'`, client)).rejects.toThrow(
          /never changes/,
        );
        await expect(
          attempt(
            client,
            `DELETE FROM neighbour_conversation_messages WHERE id = '${conversationMessageId}'`,
          ),
        ).rejects.toThrow(/append-only|permission denied/);
      }
      const erased = await change(`body = NULL, erased_at = now()`);
      expect(erased!.rowCount).toBe(1);
    });

    it('nobody blocks themselves, and a pair has one block each way', async () => {
      const insert = (blocker: string, blocked: string) =>
        asApp(
          `INSERT INTO neighbour_blocks (id, tenant_id, blocker_account_id, blocked_account_id, conversation_id)
           VALUES ('${newId()}', '${tenantId}', '${blocker}', '${blocked}', '${conversationId}')`,
        );
      await expect(insert(alice, alice)).rejects.toThrow(
        /neighbour_blocks_two_people/,
      );
      await expect(insert(alice, bob)).rejects.toThrow(
        /neighbour_blocks_one_per_pair/,
      );
      await insert(bob, alice);
    });

    it('a block is deleted to undo it, and never updated', async () => {
      expect(await privileges('neighbour_blocks')).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: true,
        truncate: false,
      });
      const gone = await asApp(
        `DELETE FROM neighbour_blocks WHERE id = '${blockId}'`,
      );
      expect(gone!.rowCount).toBe(1);
    });

    it('a report has a reason from the list, and closed has its three facts', async () => {
      const report = set('neighbour_conversation_reports', () => reportId);
      await expect(
        asApp(
          `INSERT INTO neighbour_conversation_reports (id, tenant_id, conversation_id, reporter_account_id, reason_code, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${conversationId}', '${bob}', 'boring', now())`,
        ),
      ).rejects.toThrow(/neighbour_conversation_reports_reason/);
      await expect(
        asApp(
          `INSERT INTO neighbour_conversation_reports (id, tenant_id, conversation_id, reporter_account_id, reason_code, note, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${conversationId}', '${bob}', 'spam', repeat('x', 1001), now())`,
        ),
      ).rejects.toThrow(/neighbour_conversation_reports_note_length/);
      await expect(report(`status = 'closed'`)).rejects.toThrow(
        /neighbour_conversation_reports_closed_shape/,
      );
      await expect(
        report(
          `status = 'closed', closed_at = now(), outcome = 'shrug', closed_by_account_id = '${bob}'`,
        ),
      ).rejects.toThrow(/neighbour_conversation_reports_closed_shape/);
      await report(
        `status = 'closed', closed_at = now(), outcome = 'warned', closed_by_account_id = '${bob}'`,
      );
      // One report per participant and conversation.
      await expect(
        asApp(
          `INSERT INTO neighbour_conversation_reports (id, tenant_id, conversation_id, reporter_account_id, reason_code, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${conversationId}', '${alice}', 'spam', now())`,
        ),
      ).rejects.toThrow(/neighbour_conversation_reports_one_per_reporter/);
    });

    it('a report keeps its reporter and its reason; its note is only ever cleared', async () => {
      const report = set('neighbour_conversation_reports', () => reportId);
      await expect(report(`reason_code = 'scam'`)).rejects.toThrow(
        /keeps its reporter/,
      );
      await expect(report(`note = 'Rewritten'`)).rejects.toThrow(
        /keeps its reporter/,
      );
      await report(`note = NULL`);
    });
  });

  describe('files', () => {
    const file = (purpose: string, type: string, size = 100) =>
      // A pending file is its uploader's (files_owned_or_attached).
      asApp(
        `INSERT INTO files (id, tenant_id, owner_account_id, purpose, content_type, size_bytes, status, upload_expires_at)
         VALUES ('${newId()}', '${tenantId}', '${alice}', '${purpose}', '${type}', ${size}, 'pending', now())`,
      );

    it('evidence is a photo or a PDF up to 10 MiB; a post’s photo an image up to 5 MiB; neither a video', async () => {
      await file('complaint_evidence', 'application/pdf', 10 * 1024 * 1024);
      await file('complaint_evidence', 'image/jpeg');
      await expect(
        file('complaint_evidence', 'application/pdf', 10 * 1024 * 1024 + 1),
      ).rejects.toThrow(/files_size_for_purpose/);
      await file('neighbour_post_photo', 'image/webp', 5 * 1024 * 1024);
      await expect(
        file('neighbour_post_photo', 'image/png', 5 * 1024 * 1024 + 1),
      ).rejects.toThrow(/files_size_for_purpose/);
      await expect(
        file('neighbour_post_photo', 'application/pdf'),
      ).rejects.toThrow(/files_content_type_for_purpose/);
      for (const purpose of ['complaint_evidence', 'neighbour_post_photo'])
        await expect(file(purpose, 'video/mp4')).rejects.toThrow(
          /files_content_type_for_purpose/,
        );
    });
  });

  describe.each([
    [
      'neighbour_complaint_status_history',
      () => `id = '${historyId}'`,
      `reason_code = 'complied'`,
    ],
    [
      'neighbour_complaint_attachments',
      () => `id = '${attachmentId}'`,
      'created_at = now()',
    ],
    [
      'neighbour_complaint_notices',
      () => `id = '${noticeId}'`,
      `body = 'Rewritten'`,
    ],
    [
      'neighbour_complaint_notice_recipients',
      () => `notice_id = '${noticeId}'`,
      'account_id = account_id',
    ],
    ['neighbour_post_photos', () => `id = '${photoId}'`, 'created_at = now()'],
    [
      'neighbour_item_handovers',
      () => `post_id = '${handoverPostId}'`,
      'created_at = now()',
    ],
    ['neighbour_welcomes', () => `id = '${welcomeId}'`, 'created_at = now()'],
  ])('%s is append-only', (table, where, change) => {
    it('the app holds SELECT and INSERT, and nothing else', async () => {
      expect(await privileges(table)).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
      });
    });

    it('the tables’ owner cannot update, delete or truncate it either', async () => {
      await expect(
        attempt(migrator, `UPDATE ${table} SET ${change} WHERE ${where()}`),
      ).rejects.toThrow(/append-only/);
      await expect(
        attempt(migrator, `DELETE FROM ${table} WHERE ${where()}`),
      ).rejects.toThrow(/append-only/);
      await expect(attempt(migrator, `TRUNCATE ${table}`)).rejects.toThrow(
        /append-only|cannot truncate/,
      );
    });
  });

  it('a household is welcomed once', async () => {
    await expect(
      asApp(
        `INSERT INTO neighbour_welcomes (id, tenant_id, occupancy_id, unit_id, account_id)
         SELECT '${newId()}', tenant_id, occupancy_id, unit_id, account_id
           FROM neighbour_welcomes WHERE id = '${welcomeId}'`,
      ),
    ).rejects.toThrow(/neighbour_welcomes_once_per_household/);
  });

  it('nothing of the neighbours domain is deleted by the app, but a block', async () => {
    const deletable: string[] = [];
    for (const table of [
      'neighbour_settings',
      'neighbour_complaint_categories',
      'neighbour_complaint_counters',
      'neighbour_complaints',
      'neighbour_complaint_status_history',
      'neighbour_complaint_messages',
      'neighbour_complaint_attachments',
      'neighbour_complaint_notices',
      'neighbour_complaint_notice_recipients',
      'neighbour_posts',
      'neighbour_post_photos',
      'neighbour_item_claims',
      'neighbour_item_handovers',
      'neighbour_conversations',
      'neighbour_conversation_messages',
      'neighbour_blocks',
      'neighbour_conversation_reports',
      'neighbour_welcome_templates',
      'neighbour_welcomes',
    ]) {
      const p = await privileges(table);
      expect({ table, select: p.select, truncate: p.truncate }).toEqual({
        table,
        select: true,
        truncate: false,
      });
      if (p.delete) deletable.push(table);
    }
    expect(deletable).toEqual(['neighbour_blocks']);
  });
});
