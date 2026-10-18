import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
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
} from '../setup/engagement-rows';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import { required } from '../setup/test-env';

/**
 * ADR 0040: what the community life's tables refuse by themselves, whatever
 * the service says: the CHECKs, the append-only histories, the one change a
 * suggestion's words take, and the privileges the app holds. Statements run
 * as jiwar_app (and, for the triggers, as the tables' owner too) inside a
 * tenant; every attempt is rolled back.
 */
describe('Community life tables — CHECKs, triggers and privileges', () => {
  let h: DbHarness;
  let app: Client;
  let migrator: Client;
  let tenantId: string;
  let accountId: string;
  let unitId: string;
  let topicId: string;
  let announcementId: string;
  let versionId: string;
  let attachmentId: string;
  let eventId: string;
  let pollId: string;
  let suggestionId: string;
  let updateId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Engagement schema');
    accountId = (await createAccountRow(h, tenantId)).id;
    unitId = (await createUnit(h, tenantId)).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        const by = { tenantId, createdById: accountId };
        topicId = await suggestionTopicRow(tx, tenantId);
        announcementId = await announcementRow(tx, by);
        versionId = (
          await tx.announcementVersion.findFirstOrThrow({
            where: { announcementId },
          })
        ).id;
        attachmentId = newId();
        await tx.announcementAttachment.create({
          data: {
            id: attachmentId,
            tenantId,
            announcementId,
            fileId: await communityFileRow(tx, tenantId),
            uploadedById: accountId,
          },
        });
        await tx.announcementReadMark.create({
          data: {
            tenantId,
            announcementId,
            kind: 'account',
            ref: new Uint8Array(randomBytes(32)),
          },
        });
        eventId = await eventRow(tx, by);
        pollId = await pollRow(tx, by);
        await tx.pollParticipation.create({
          data: { tenantId, pollId, unitId },
        });
        suggestionId = await suggestionRow(tx, {
          tenantId,
          authorId: accountId,
          topicId,
        });
        updateId = newId();
        await tx.suggestionUpdate.create({
          data: {
            id: updateId,
            tenantId,
            suggestionId,
            status: 'under_review',
            byId: accountId,
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

  describe('announcements', () => {
    const set = (assignments: string) =>
      asApp(
        `UPDATE announcements SET ${assignments} WHERE id = '${announcementId}'`,
      );

    it('only an important announcement is pinned', async () => {
      await expect(
        set(`pinned_until = now() + interval '1 day'`),
      ).rejects.toThrow(/announcements_pin_is_important/);
      await set(
        `priority = 'important', pinned_until = now() + interval '1 day'`,
      );
    });

    it('an expiry is a general announcement’s and comes after its publication', async () => {
      await expect(set(`expires_at = publish_at`)).rejects.toThrow(
        /announcements_expiry/,
      );
      await set(`expires_at = publish_at + interval '1 day'`);
      // A draft may carry one: there is nothing to compare it with yet.
      await set(`publish_at = NULL, expires_at = now()`);
    });

    it('works have their dates, in order, and their area; a general announcement has none of it', async () => {
      await expect(set(`works_starts_at = now()`)).rejects.toThrow(
        /announcements_works_shape/,
      );
      await expect(set(`works_place = 'The pool'`)).rejects.toThrow(
        /announcements_works_shape/,
      );
      const works = `kind = 'works', works_starts_at = now(), works_area_kind = 'road'`;
      await expect(set(`${works}, works_ends_at = now()`)).rejects.toThrow(
        /announcements_works_window/,
      );
      await set(`${works}, works_ends_at = now() + interval '1 hour'`);
      await expect(
        set(
          `${works}, works_ends_at = now() + interval '1 hour', expires_at = now() + interval '2 hours'`,
        ),
      ).rejects.toThrow(/announcements_expiry/);
      // A gate is named only for works at a gate.
      await expect(
        set(
          `${works}, works_ends_at = now() + interval '1 hour', works_gate_id = '${newId()}'`,
        ),
      ).rejects.toThrow(/announcements_works_gate/);
    });

    it('edited and announced only once it is out; a version is numbered from one', async () => {
      await expect(set(`publish_at = NULL, edited_at = now()`)).rejects.toThrow(
        /announcements_out_first/,
      );
      await expect(
        set(`publish_at = NULL, notified_at = now()`),
      ).rejects.toThrow(/announcements_out_first/);
      await expect(set(`current_version = 0`)).rejects.toThrow(
        /announcements_version_positive/,
      );
    });

    it('at most fifty buildings, none of them NULL', async () => {
      await expect(
        set(
          `audience_buildings = ARRAY(SELECT 'B' || g FROM generate_series(1, 51) g)`,
        ),
      ).rejects.toThrow(/announcements_audience_buildings/);
      await expect(
        set(`audience_buildings = ARRAY['A', NULL]`),
      ).rejects.toThrow(/announcements_audience_buildings/);
    });

    it('a version is whole per language, within its lengths, with at most five files', async () => {
      const version = (columns: string, values: string) =>
        asApp(
          `INSERT INTO announcement_versions
             (id, tenant_id, announcement_id, version, edited_by_account_id, ${columns})
           VALUES ('${newId()}', '${tenantId}', '${announcementId}', 99, '${accountId}', ${values})`,
        );
      await version('title_ar, body_ar', `'عنوان', 'نص'`);
      await expect(version('title_en', `'Only a title'`)).rejects.toThrow(
        /announcement_versions_languages/,
      );
      await expect(
        version('title_en, body_en, title_ar', `'T', 'B', 'عنوان'`),
      ).rejects.toThrow(/announcement_versions_languages/);
      await expect(
        version('title_en, body_en', `repeat('x', 151), 'B'`),
      ).rejects.toThrow(/announcement_versions_lengths/);
      await expect(version('title_en, body_en', `'', 'B'`)).rejects.toThrow(
        /announcement_versions_lengths/,
      );
      await expect(
        version(
          'title_en, body_en, attachment_ids',
          `'T', 'B', ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 6))`,
        ),
      ).rejects.toThrow(/announcement_versions_attachments/);
      // One row per version number.
      await expect(
        asApp(
          `INSERT INTO announcement_versions
             (id, tenant_id, announcement_id, version, edited_by_account_id, title_en, body_en)
           VALUES ('${newId()}', '${tenantId}', '${announcementId}', 1, '${accountId}', 'T', 'B')`,
        ),
      ).rejects.toThrow(/announcement_versions_announcement_version_key/);
    });

    it('a read mark is 32 bytes, once', async () => {
      const mark = (ref: string) =>
        asApp(
          `INSERT INTO announcement_read_marks (tenant_id, announcement_id, kind, ref)
           VALUES ('${tenantId}', '${announcementId}', 'unit', ${ref})`,
        );
      await expect(mark(`'\\x00'`)).rejects.toThrow(
        /announcement_read_marks_ref_length/,
      );
      const ref = `'\\x${randomBytes(32).toString('hex')}'`;
      await expect(
        asApp(
          `INSERT INTO announcement_read_marks (tenant_id, announcement_id, kind, ref)
           VALUES ('${tenantId}', '${announcementId}', 'unit', ${ref}),
                  ('${tenantId}', '${announcementId}', 'unit', ${ref})`,
        ),
      ).rejects.toThrow(/announcement_read_marks_pkey/);
    });
  });

  describe('events', () => {
    const set = (assignments: string) =>
      asApp(
        `UPDATE community_events SET ${assignments} WHERE id = '${eventId}'`,
      );
    const rsvp = (response: string, guests: number) =>
      asApp(
        `INSERT INTO event_rsvps (id, tenant_id, event_id, account_id, unit_id, response, guests, updated_at)
         VALUES ('${newId()}', '${tenantId}', '${eventId}', '${accountId}', '${unitId}', '${response}', ${guests}, now())`,
      );

    it('ends after it starts; a capacity is at least one; a language is whole', async () => {
      await expect(set(`ends_at = starts_at`)).rejects.toThrow(
        /community_events_window/,
      );
      await expect(set(`capacity = 0`)).rejects.toThrow(
        /community_events_capacity/,
      );
      await set(`capacity = NULL`);
      await expect(set(`description_en = NULL`)).rejects.toThrow(
        /community_events_languages/,
      );
      await expect(set(`place = ''`)).rejects.toThrow(
        /community_events_lengths/,
      );
    });

    it('cancelled with a reason from the list, and only then', async () => {
      await expect(set(`cancelled_at = now()`)).rejects.toThrow(
        /community_events_cancelled/,
      );
      await expect(set(`cancel_reason = 'weather'`)).rejects.toThrow(
        /community_events_cancelled/,
      );
      await expect(
        set(`cancelled_at = now(), cancel_reason = 'boredom'`),
      ).rejects.toThrow(/community_events_cancelled/);
      await set(`cancelled_at = now(), cancel_reason = 'weather'`);
    });

    it('guests come with someone who is going, twenty at most; one answer per account', async () => {
      await rsvp('going', 20);
      await expect(rsvp('going', 21)).rejects.toThrow(/event_rsvps_guests/);
      await expect(rsvp('going', -1)).rejects.toThrow(/event_rsvps_guests/);
      await expect(rsvp('not_going', 1)).rejects.toThrow(/event_rsvps_guests/);
      const row = `('${newId()}', '${tenantId}', '${eventId}', '${accountId}', '${unitId}', 'going', 0, now())`;
      await expect(
        asApp(
          `INSERT INTO event_rsvps (id, tenant_id, event_id, account_id, unit_id, response, guests, updated_at)
           VALUES ${row}, ${row.replace(/'[0-9a-f-]{36}'/, `'${newId()}'`)}`,
        ),
      ).rejects.toThrow(/event_rsvps_one_per_account/);
    });
  });

  describe('polls', () => {
    const set = (assignments: string) =>
      asApp(`UPDATE polls SET ${assignments} WHERE id = '${pollId}'`);

    it('closes after it opens; has a question', async () => {
      await expect(set(`closes_at = opens_at`)).rejects.toThrow(/polls_window/);
      await expect(set(`question_en = NULL`)).rejects.toThrow(/polls_question/);
      await expect(set(`question_en = repeat('x', 501)`)).rejects.toThrow(
        /polls_question/,
      );
    });

    it('the salt lives exactly as long as the poll is neither closed nor cancelled; the turnout is a closed poll’s', async () => {
      // Ended with its salt still there: refused, both ways.
      await expect(set(`closed_at = now(), final_turnout = 0`)).rejects.toThrow(
        /polls_end_shape/,
      );
      await expect(set(`cancelled_at = now()`)).rejects.toThrow(
        /polls_end_shape/,
      );
      // Open without a salt: refused.
      await expect(set(`ballot_salt = NULL`)).rejects.toThrow(
        /polls_end_shape/,
      );
      // Closed without its turnout, or cancelled with one: refused.
      await expect(
        set(`closed_at = now(), ballot_salt = NULL`),
      ).rejects.toThrow(/polls_end_shape/);
      await expect(
        set(`cancelled_at = now(), ballot_salt = NULL, final_turnout = 0`),
      ).rejects.toThrow(/polls_end_shape/);
      // Never both ends.
      await expect(
        set(
          `closed_at = now(), cancelled_at = now(), ballot_salt = NULL, final_turnout = 0`,
        ),
      ).rejects.toThrow(/polls_end_shape/);
      await set(`closed_at = now(), ballot_salt = NULL, final_turnout = 0`);
      await set(`cancelled_at = now(), ballot_salt = NULL`);
      await expect(set(`ballot_salt = '\\x00'`)).rejects.toThrow(
        /polls_salt_length/,
      );
    });

    it('an option has a label and a place from one to ten, once; a count is not negative', async () => {
      const option = (position: number, extra = `'Yes'`) =>
        `('${newId()}', '${tenantId}', '${pollId}', ${position}, ${extra})`;
      const insert = (...rows: string[]) =>
        asApp(
          `INSERT INTO poll_options (id, tenant_id, poll_id, position, label_en) VALUES ${rows.join(', ')}`,
        );
      await insert(option(1), option(10));
      await expect(insert(option(0))).rejects.toThrow(/poll_options_position/);
      await expect(insert(option(11))).rejects.toThrow(/poll_options_position/);
      await expect(insert(option(1), option(1))).rejects.toThrow(
        /poll_options_position_key/,
      );
      await expect(insert(option(1, 'NULL'))).rejects.toThrow(
        /poll_options_label/,
      );
      await expect(
        asApp(
          `INSERT INTO poll_options (id, tenant_id, poll_id, position, label_en, final_count)
           VALUES ('${newId()}', '${tenantId}', '${pollId}', 1, 'Yes', -1)`,
        ),
      ).rejects.toThrow(/poll_options_final_count/);
    });

    it('a ballot box is one row per poll, holding an object', async () => {
      const box = (ballots: string) =>
        asApp(
          `INSERT INTO poll_ballot_boxes (tenant_id, poll_id, ballots)
           VALUES ('${tenantId}', '${pollId}', '${ballots}'::jsonb)`,
        );
      await box('{}');
      await expect(box('[]')).rejects.toThrow(/poll_ballot_boxes_is_object/);
      await expect(
        asApp(
          `INSERT INTO poll_ballot_boxes (tenant_id, poll_id)
           VALUES ('${tenantId}', '${pollId}'), ('${tenantId}', '${pollId}')`,
        ),
      ).rejects.toThrow(/poll_ballot_boxes_pkey/);
    });
  });

  describe('suggestions', () => {
    const set = (assignments: string) =>
      asApp(
        `UPDATE suggestions SET ${assignments} WHERE id = '${suggestionId}'`,
      );

    it('a response has its time; a summary is whole and means published; a note is a done suggestion’s', async () => {
      await expect(set(`response = 'Thanks'`)).rejects.toThrow(
        /suggestions_response_time/,
      );
      await set(`response = 'Thanks', responded_at = now()`);
      await expect(set(`published_at = now()`)).rejects.toThrow(
        /suggestions_published_summary/,
      );
      await expect(
        set(`published_at = now(), public_title_en = 'T'`),
      ).rejects.toThrow(/suggestions_published_summary/);
      await expect(
        set(`public_title_en = 'T', public_text_en = 'X'`),
      ).rejects.toThrow(/suggestions_published_summary/);
      await set(
        `published_at = now(), public_title_ar = 'ع', public_text_ar = 'ن'`,
      );
      await expect(set(`done_note_en = 'Done'`)).rejects.toThrow(
        /suggestions_done_shape/,
      );
      await expect(set(`status = 'done'`)).rejects.toThrow(
        /suggestions_done_shape/,
      );
      await expect(set(`done_at = now()`)).rejects.toThrow(
        /suggestions_done_shape/,
      );
      await set(`status = 'done', done_at = now(), done_note_en = 'Done'`);
      await expect(
        set(`response = repeat('x', 2001), responded_at = now()`),
      ).rejects.toThrow(/suggestions_lengths/);
    });

    it('its words are there or erased, never both and never neither', async () => {
      await expect(
        asApp(
          `INSERT INTO suggestions (id, tenant_id, author_account_id, topic_id, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${accountId}', '${topicId}', now())`,
        ),
      ).rejects.toThrow(/suggestions_body_or_erased/);
      await expect(
        asApp(
          `INSERT INTO suggestions (id, tenant_id, author_account_id, topic_id, body, erased_at, updated_at)
           VALUES ('${newId()}', '${tenantId}', '${accountId}', '${topicId}', 'x', now(), now())`,
        ),
      ).rejects.toThrow(/suggestions_body_or_erased/);
    });

    describe.each([
      ['the app', () => app],
      ['the tables’ owner', () => migrator],
    ])('as %s, a suggestion keeps its author and its words', (_, client) => {
      const change = (assignments: string) =>
        attempt(
          client(),
          `UPDATE suggestions SET ${assignments} WHERE id = '${suggestionId}'`,
        );

      it('the one change its words take is the erasure’s: cleared once, with its time', async () => {
        const erased = await change(`body = NULL, erased_at = now()`);
        expect(erased!.rowCount).toBe(1);
        // Anything else about the words is refused.
        for (const rewrite of [
          `body = 'Rewritten by someone'`,
          `erased_at = now()`,
          `body = NULL`,
        ])
          await expect(change(rewrite)).rejects.toThrow(
            /keeps its author and its words/,
          );
        // And once erased it stays erased.
        await expect(
          attempt(
            client(),
            `UPDATE suggestions SET body = NULL, erased_at = now() WHERE id = '${suggestionId}'`,
            `UPDATE suggestions SET body = 'Back again', erased_at = NULL WHERE id = '${suggestionId}'`,
          ),
        ).rejects.toThrow(/keeps its author and its words/);
      });

      it('who wrote it, about what, for which unit and when never change; it is never deleted', async () => {
        for (const rewrite of [
          `author_account_id = '${newId()}'`,
          `topic_id = '${newId()}'`,
          `unit_id = '${unitId}'`,
          `created_at = now() + interval '1 day'`,
        ])
          await expect(change(rewrite)).rejects.toThrow(
            /keeps its author and its words|foreign key/,
          );
        await expect(
          attempt(
            client(),
            `DELETE FROM suggestions WHERE id = '${suggestionId}'`,
          ),
        ).rejects.toThrow(/keeps its author and its words|permission denied/);
        // What the staff do to it is free.
        const moved = await change(`status = 'planned'`);
        expect(moved!.rowCount).toBe(1);
      });
    });
  });

  describe.each([
    [
      'announcement_versions',
      () => `id = '${versionId}'`,
      `title_en = 'Rewritten'`,
    ],
    [
      'announcement_attachments',
      () => `id = '${attachmentId}'`,
      'created_at = now()',
    ],
    [
      'announcement_read_marks',
      () => `announcement_id = '${announcementId}'`,
      `kind = 'unit'`,
    ],
    ['poll_participations', () => `poll_id = '${pollId}'`, `unit_id = unit_id`],
    [
      'suggestion_updates',
      () => `id = '${updateId}'`,
      `response = 'Rewritten'`,
    ],
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

  it('nothing of the community life is deleted by the app, but an answer, a child registration, a support, an option and a ballot box', async () => {
    const deletable: string[] = [];
    for (const table of [
      'engagement_settings',
      'suggestion_topics',
      'announcements',
      'announcement_versions',
      'announcement_attachments',
      'announcement_read_marks',
      'community_events',
      'event_attachments',
      'event_rsvps',
      // ADR 0054: taken back before the start, or with the child leaving.
      'event_child_registrations',
      'polls',
      'poll_options',
      'poll_ballot_boxes',
      'poll_participations',
      'suggestions',
      'suggestion_updates',
      'suggestion_attachments',
      'suggestion_supports',
    ]) {
      const p = await privileges(table);
      expect({ table, select: p.select, truncate: p.truncate }).toEqual({
        table,
        select: true,
        truncate: false,
      });
      if (p.delete) deletable.push(table);
    }
    expect(deletable).toEqual([
      'event_rsvps',
      'event_child_registrations',
      'poll_options',
      'poll_ballot_boxes',
      'suggestion_supports',
    ]);
  });
});
