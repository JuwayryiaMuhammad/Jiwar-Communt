import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant } from '../setup/fixtures';
import { requestRow, topicRow } from '../setup/management-rows';

/**
 * ADR 0039: what the management tables refuse by themselves, whatever the
 * service says. Run as jiwar_app inside a tenant, like the app; every
 * attempt is rolled back.
 */
describe('Management tables — CHECKs and indexes', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let residentId: string;
  let staffId: string;
  let topicId: string;
  let requestId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Management schema');
    residentId = (await createAccountRow(h, tenantId)).id;
    staffId = (await createAccountRow(h, tenantId, 'manager')).id;
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx: TenantTxClient) => {
        topicId = await topicRow(tx, tenantId);
        requestId = await requestRow(tx, {
          tenantId,
          topicId,
          authorId: residentId,
        });
      }),
    );
    app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
    await h.close();
  });

  /** Runs the statements in one transaction that is always rolled back. */
  async function attempt(...statements: string[]): Promise<void> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      for (const sql of statements) await app.query(sql);
    } finally {
      await app.query('ROLLBACK');
    }
  }

  /** An INSERT from a base row and its overrides (SQL text values). */
  const insert = (
    table: string,
    base: Record<string, string>,
    columns: Record<string, string>,
  ) => {
    const row = { ...base, ...columns };
    return `INSERT INTO ${table} (${Object.keys(row).join(', ')})
            VALUES (${Object.values(row).join(', ')})`;
  };

  let number = 1;
  const topic = (columns: Record<string, string> = {}) =>
    insert(
      'management_request_topics',
      {
        id: `'${newId()}'`,
        tenant_id: `'${tenantId}'`,
        key: `'t_${number++}'`,
        name_ar: `'موضوع'`,
        name_en: `'Topic'`,
        target_response_hours: '24',
        updated_at: 'now()',
      },
      columns,
    );
  const request = (columns: Record<string, string> = {}) =>
    insert(
      'management_requests',
      {
        id: `'${newId()}'`,
        tenant_id: `'${tenantId}'`,
        number: String(5000 + number++),
        type: `'question'`,
        topic_id: `'${topicId}'`,
        author_account_id: `'${residentId}'`,
        cycle_started_at: 'now()',
        response_due_at: `now() + interval '1 hour'`,
        last_activity_at: 'now()',
        updated_at: 'now()',
      },
      columns,
    );
  const message = (columns: Record<string, string> = {}) =>
    insert(
      'management_request_messages',
      {
        id: `'${newId()}'`,
        tenant_id: `'${tenantId}'`,
        request_id: `'${requestId}'`,
        sender_account_id: `'${residentId}'`,
        sender_side: `'resident'`,
        body: `'Hello'`,
        cycle: '1',
      },
      columns,
    );
  const appointment = (columns: Record<string, string> = {}) =>
    insert(
      'management_appointments',
      {
        id: `'${newId()}'`,
        tenant_id: `'${tenantId}'`,
        request_id: `'${requestId}'`,
        status: `'requested'`,
        mode: `'in_person'`,
        starts_at: `'2031-03-01T09:00:00Z'`,
        ends_at: `'2031-03-01T09:30:00Z'`,
        proposed_by_side: `'resident'`,
        proposed_by_account_id: `'${residentId}'`,
        updated_at: 'now()',
      },
      columns,
    );
  const closed = (reason: string, side: string) => ({
    status: `'closed'`,
    closed_at: 'now()',
    close_reason: `'${reason}'`,
    closed_by_side: `'${side}'`,
  });

  describe('topics, settings and office hours', () => {
    it('a topic with the least it needs is accepted', async () => {
      await expect(attempt(topic())).resolves.toBeUndefined();
    });

    it('a key is lowercase snake case, and unique in the compound', async () => {
      await expect(attempt(topic({ key: `'Billing'` }))).rejects.toThrow(
        /management_request_topics_key_shape/,
      );
      await expect(attempt(topic({ key: `'9x'` }))).rejects.toThrow(
        /management_request_topics_key_shape/,
      );
      await expect(
        attempt(topic({ key: `'same'` }), topic({ key: `'same'` })),
      ).rejects.toThrow(/management_request_topics_tenant_id_key_key/);
    });

    it('names are 1 to 80 characters, the target 1 to 720 hours', async () => {
      await expect(attempt(topic({ name_en: `''` }))).rejects.toThrow(
        /management_request_topics_names_length/,
      );
      await expect(
        attempt(topic({ name_ar: `'${'x'.repeat(81)}'` })),
      ).rejects.toThrow(/management_request_topics_names_length/);
      for (const hours of ['0', '721'])
        await expect(
          attempt(topic({ target_response_hours: hours })),
        ).rejects.toThrow(/management_request_topics_target/);
    });

    it.each([
      ['auto_close_days', '0'],
      ['auto_close_days', '91'],
      ['appointment_slot_minutes', '9'],
      ['appointment_slot_minutes', '241'],
      ['appointment_slot_capacity', '0'],
      ['appointment_slot_capacity', '51'],
    ])('settings: %s = %s is out of range', async (column, value) => {
      await expect(
        attempt(
          `INSERT INTO management_request_settings (tenant_id, updated_at, ${column})
           VALUES ('${tenantId}', now(), ${value})
           ON CONFLICT (tenant_id) DO UPDATE SET ${column} = ${value}`,
        ),
      ).rejects.toThrow(/management_request_settings_ranges/);
    });

    const hours = (weekday: number, start: number, end: number) =>
      `INSERT INTO management_office_hours (id, tenant_id, weekday, start_minute, end_minute)
       VALUES ('${newId()}', '${tenantId}', ${weekday}, ${start}, ${end})`;

    it('a window is a weekday and a start before its end, within the day', async () => {
      await expect(attempt(hours(5, 1, 2))).resolves.toBeUndefined();
      await expect(attempt(hours(5, 0, 1440))).resolves.toBeUndefined();
      for (const [weekday, start, end] of [
        [7, 540, 600],
        [-1, 540, 600],
        [5, 600, 600],
        [5, 600, 540],
        [5, -1, 60],
        [5, 1400, 1441],
      ])
        await expect(attempt(hours(weekday, start, end))).rejects.toThrow(
          /management_office_hours_window/,
        );
    });

    it('two windows of one weekday cannot start together', async () => {
      await expect(attempt(hours(5, 3, 4), hours(5, 3, 9))).rejects.toThrow(
        /management_office_hours_window_key/,
      );
    });
  });

  describe('management_requests', () => {
    it('an open request with the least it needs is accepted', async () => {
      await expect(attempt(request())).resolves.toBeUndefined();
    });

    it('the number is positive and unique in the compound', async () => {
      await expect(attempt(request({ number: '0' }))).rejects.toThrow(
        /management_requests_number_positive/,
      );
      await expect(
        attempt(request({ number: '777777' }), request({ number: '777777' })),
      ).rejects.toThrow(/management_requests_tenant_id_number_key/);
    });

    it('a cycle is at least 1 and its due time is after its start', async () => {
      await expect(attempt(request({ cycle: '0' }))).rejects.toThrow(
        /management_requests_cycle/,
      );
      await expect(
        attempt(request({ response_due_at: 'now()' })),
      ).rejects.toThrow(/management_requests_cycle/);
    });

    it('opened on behalf: the staff member and a listed reason, together', async () => {
      await expect(
        attempt(
          request({
            opened_by_account_id: `'${staffId}'`,
            on_behalf_reason: `'resident_walk_in'`,
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        attempt(request({ opened_by_account_id: `'${staffId}'` })),
      ).rejects.toThrow(/management_requests_on_behalf/);
      await expect(
        attempt(request({ on_behalf_reason: `'resident_walk_in'` })),
      ).rejects.toThrow(/management_requests_on_behalf/);
      await expect(
        attempt(
          request({
            opened_by_account_id: `'${staffId}'`,
            on_behalf_reason: `'felt_like_it'`,
          }),
        ),
      ).rejects.toThrow(/management_requests_on_behalf/);
    });

    it('closed has its time, reason and side; nothing else has any', async () => {
      await expect(
        attempt(request(closed('resolved', 'staff'))),
      ).resolves.toBeUndefined();
      await expect(attempt(request({ status: `'closed'` }))).rejects.toThrow(
        /management_requests_closed_shape/,
      );
      await expect(attempt(request({ closed_at: 'now()' }))).rejects.toThrow(
        /management_requests_closed_shape/,
      );
      await expect(
        attempt(request({ close_reason: `'resolved'` })),
      ).rejects.toThrow(/management_requests_closed_shape/);
      await expect(
        attempt(request({ closed_by_side: `'staff'` })),
      ).rejects.toThrow(/management_requests_closed_shape/);
      await expect(
        attempt(
          request({ ...closed('resolved', 'staff'), closed_by_side: 'NULL' }),
        ),
      ).rejects.toThrow(/management_requests_closed_shape/);
      await expect(attempt(request(closed('bored', 'staff')))).rejects.toThrow(
        /management_requests_closed_shape/,
      );
    });

    it.each([
      ['auto_closed', 'system', true],
      ['withdrawn_by_author', 'resident', true],
      ['resolved', 'staff', true],
      ['auto_closed', 'staff', false],
      ['auto_closed', 'resident', false],
      ['withdrawn_by_author', 'staff', false],
      ['withdrawn_by_author', 'system', false],
      ['resolved', 'system', false],
      ['resolved', 'resident', false],
    ])('closed as %s by %s: accepted = %s', async (reason, side, ok) => {
      const run = attempt(request(closed(reason, side)));
      if (ok) await expect(run).resolves.toBeUndefined();
      else
        await expect(run).rejects.toThrow(
          /management_requests_close_reason_side/,
        );
    });

    it('answered has the time of its official reply', async () => {
      await expect(attempt(request({ status: `'answered'` }))).rejects.toThrow(
        /management_requests_answered_at/,
      );
      await expect(
        attempt(request({ status: `'answered'`, answered_at: 'now()' })),
      ).resolves.toBeUndefined();
    });

    it('a topic, an author and a unit of the compound only', async () => {
      for (const column of ['topic_id', 'author_account_id', 'unit_id'])
        await expect(
          attempt(request({ [column]: `'${newId()}'` })),
        ).rejects.toThrow(/foreign key/);
    });
  });

  describe('management_request_messages', () => {
    it('a resident message is accepted', async () => {
      await expect(attempt(message())).resolves.toBeUndefined();
    });

    it('a body is 1 to 4000 characters', async () => {
      await expect(attempt(message({ body: `''` }))).rejects.toThrow(
        /management_request_messages_body_length/,
      );
      await expect(
        attempt(message({ body: `'${'x'.repeat(4001)}'` })),
      ).rejects.toThrow(/management_request_messages_body_length/);
    });

    it('no body means erased, and erased means no body', async () => {
      await expect(attempt(message({ body: 'NULL' }))).rejects.toThrow(
        /management_request_messages_erased_shape/,
      );
      await expect(attempt(message({ erased_at: 'now()' }))).rejects.toThrow(
        /management_request_messages_erased_shape/,
      );
    });

    it('only staff write a note or an official reply, and never both in one', async () => {
      const staff = {
        sender_account_id: `'${staffId}'`,
        sender_side: `'staff'`,
      };
      await expect(
        attempt(message({ ...staff, internal: 'true' })),
      ).resolves.toBeUndefined();
      await expect(
        attempt(message({ ...staff, official: 'true' })),
      ).resolves.toBeUndefined();
      const refused: Record<string, string>[] = [
        { internal: 'true' },
        { official: 'true' },
        { ...staff, internal: 'true', official: 'true' },
      ];
      for (const columns of refused)
        await expect(attempt(message(columns))).rejects.toThrow(
          /management_request_messages_staff_flags/,
        );
    });

    it('the cycle is at least 1', async () => {
      await expect(attempt(message({ cycle: '0' }))).rejects.toThrow(
        /management_request_messages_cycle_positive/,
      );
    });

    it('an attachment’s message belongs to its request', async () => {
      const other = newId();
      const messageId = newId();
      const fileId = newId();
      await expect(
        attempt(
          request({ id: `'${other}'` }),
          message({ id: `'${messageId}'` }),
          `INSERT INTO files (id, tenant_id, purpose, content_type, size_bytes, status,
             upload_expires_at, finalized_at, attached_at)
           VALUES ('${fileId}', '${tenantId}', 'request_attachment', 'application/pdf',
             100, 'ready', now(), now(), now())`,
          // The message is the first request's; the row names the other.
          `INSERT INTO management_request_attachments
             (id, tenant_id, request_id, message_id, file_id, uploaded_by_account_id)
           VALUES ('${newId()}', '${tenantId}', '${other}', '${messageId}',
             '${fileId}', '${residentId}')`,
        ),
      ).rejects.toThrow(/management_request_attachments_message_fkey/);
    });
  });

  describe('files of a message', () => {
    const file = (contentType: string, purpose: string, size = 100) =>
      `INSERT INTO files (id, tenant_id, purpose, content_type, size_bytes, status, upload_expires_at)
       VALUES ('${newId()}', '${tenantId}', '${purpose}', '${contentType}', ${size}, 'pending', now())`;

    it('an image or a PDF up to 10 MiB, and no archive', async () => {
      await expect(
        attempt(file('image/png', 'request_attachment')),
      ).resolves.toBeUndefined();
      await expect(
        attempt(
          file('application/pdf', 'request_attachment', 10 * 1024 * 1024),
        ),
      ).resolves.toBeUndefined();
      await expect(
        attempt(
          file('application/pdf', 'request_attachment', 10 * 1024 * 1024 + 1),
        ),
      ).rejects.toThrow(/files_size_for_purpose/);
      await expect(
        attempt(file('application/zip', 'request_attachment')),
      ).rejects.toThrow(/files_content_type_for_purpose/);
    });

    it('a PDF is still refused where it was (a ticket photo)', async () => {
      await expect(
        attempt(file('application/pdf', 'ticket_photo')),
      ).rejects.toThrow(/files_content_type_for_purpose/);
    });
  });

  describe('escalations and ratings', () => {
    const escalation = (cycle: number, request = requestId) =>
      `INSERT INTO management_request_escalations (id, tenant_id, request_id, cycle, due_at)
       VALUES ('${newId()}', '${tenantId}', '${request}', ${cycle}, now())`;
    const rating = (value: string, comment = 'NULL') =>
      `INSERT INTO management_request_ratings (tenant_id, request_id, author_account_id, rating, comment)
       VALUES ('${tenantId}', '${requestId}', '${residentId}', ${value}, ${comment})`;

    it('one escalation per cycle of a request', async () => {
      await expect(
        attempt(escalation(1), escalation(2), escalation(1, newId())),
      ).resolves.toBeUndefined();
      await expect(attempt(escalation(1), escalation(1))).rejects.toThrow(
        /management_request_escalations_once_per_cycle/,
      );
      await expect(attempt(escalation(0))).rejects.toThrow(
        /management_request_escalations_cycle_positive/,
      );
    });

    it('a rating is 1 to 5, its comment 1 to 1000 characters', async () => {
      await expect(attempt(rating('5', `'Thanks'`))).resolves.toBeUndefined();
      for (const value of ['0', '6'])
        await expect(attempt(rating(value))).rejects.toThrow(
          /management_request_ratings_rating/,
        );
      await expect(attempt(rating('3', `''`))).rejects.toThrow(
        /management_request_ratings_comment_length/,
      );
      await expect(
        attempt(rating('3', `'${'x'.repeat(1001)}'`)),
      ).rejects.toThrow(/management_request_ratings_comment_length/);
    });

    it('one rating per request', async () => {
      await expect(attempt(rating('5'), rating('4'))).rejects.toThrow(
        /management_request_ratings_pkey/,
      );
    });
  });

  describe('management_appointments', () => {
    const ended = (status: string, extra: Record<string, string> = {}) => ({
      status: `'${status}'`,
      ended_at: 'now()',
      ...extra,
    });

    it('a requested appointment is accepted', async () => {
      await expect(attempt(appointment())).resolves.toBeUndefined();
    });

    it('the window ends after it starts, at most four hours later', async () => {
      await expect(
        attempt(appointment({ ends_at: `'2031-03-01T09:00:00Z'` })),
      ).rejects.toThrow(/management_appointments_window/);
      await expect(
        attempt(appointment({ ends_at: `'2031-03-01T13:00:01Z'` })),
      ).rejects.toThrow(/management_appointments_window/);
    });

    it('a request has one live appointment; ended ones do not count', async () => {
      await expect(
        attempt(appointment(), appointment({ status: `'proposed'` })),
      ).rejects.toThrow(/management_appointments_one_live_per_request/);
      await expect(
        attempt(
          appointment(ended('superseded')),
          appointment(
            ended('cancelled', {
              cancel_reason: `'cannot_attend'`,
              cancelled_by_side: `'resident'`,
            }),
          ),
          appointment(),
        ),
      ).resolves.toBeUndefined();
    });

    it('ended means cancelled or superseded, and only then', async () => {
      await expect(attempt(appointment({ ended_at: 'now()' }))).rejects.toThrow(
        /management_appointments_end_shape/,
      );
      await expect(
        attempt(appointment({ status: `'superseded'` })),
      ).rejects.toThrow(/management_appointments_end_shape/);
    });

    it('a cancellation has a listed reason and its side; nothing else has', async () => {
      await expect(attempt(appointment(ended('cancelled')))).rejects.toThrow(
        /management_appointments_end_shape/,
      );
      await expect(
        attempt(
          appointment(ended('cancelled', { cancel_reason: `'cannot_attend'` })),
        ),
      ).rejects.toThrow(/management_appointments_end_shape/);
      await expect(
        attempt(
          appointment(
            ended('cancelled', {
              cancel_reason: `'raining'`,
              cancelled_by_side: `'resident'`,
            }),
          ),
        ),
      ).rejects.toThrow(/management_appointments_end_shape/);
      await expect(
        attempt(
          appointment(
            ended('superseded', {
              cancel_reason: `'other'`,
              cancelled_by_side: `'staff'`,
            }),
          ),
        ),
      ).rejects.toThrow(/management_appointments_end_shape/);
      await expect(
        attempt(appointment({ cancelled_by_side: `'staff'` })),
      ).rejects.toThrow(/management_appointments_end_shape/);
    });

    it('confirmed has the time it was confirmed', async () => {
      await expect(
        attempt(appointment({ status: `'confirmed'` })),
      ).rejects.toThrow(/management_appointments_confirmed_at/);
      await expect(
        attempt(appointment({ status: `'confirmed'`, confirmed_at: 'now()' })),
      ).resolves.toBeUndefined();
    });

    it('a slot lock exists once per start', async () => {
      const slot = `INSERT INTO management_appointment_slots (tenant_id, starts_at)
                    VALUES ('${tenantId}', '2031-03-01T09:00:00Z')`;
      await expect(attempt(slot, slot)).rejects.toThrow(
        /management_appointment_slots_pkey/,
      );
    });
  });
});
