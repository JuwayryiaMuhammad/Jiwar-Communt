import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { required } from '../setup/test-env';

/**
 * ADR 0036: the consent history is append-only like the ticket histories:
 * rows can be inserted and read, never changed or removed — not by the
 * app, not by the table owner.
 */
describe('consent_events is immutable', () => {
  const table = 'consent_events';
  let app: Client;
  let migrator: Client;
  const tenantId = newId();
  const id = newId();
  const accountId = newId();

  beforeAll(async () => {
    app = new Client({ connectionString: process.env.DATABASE_URL });
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await app.connect();
    await migrator.connect();
    await attempt(
      app,
      `INSERT INTO consent_events (id, tenant_id, account_id, code, version,
         action, actor_type, actor_account_id)
       VALUES ('${id}', '${tenantId}', '${accountId}', 'ticket_phone_share', 1,
         'grant', 'account', '${accountId}')`,
    );
  });

  afterAll(async () => {
    await app.end();
    await migrator.end();
  });

  async function attempt(client: Client, sql: string) {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const res = await client.query(sql);
      await client.query('COMMIT');
      return res;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  const update = () => `UPDATE ${table} SET version = 9 WHERE id = '${id}'`;
  const remove = () => `DELETE FROM ${table} WHERE id = '${id}'`;
  const truncate = () => `TRUNCATE ${table}`;

  it('jiwar_app has only SELECT and INSERT', async () => {
    const { rows } = await app.query<Record<string, boolean>>(
      `SELECT has_table_privilege($1, 'SELECT') AS select,
              has_table_privilege($1, 'INSERT') AS insert,
              has_table_privilege($1, 'UPDATE') AS update,
              has_table_privilege($1, 'DELETE') AS delete,
              has_table_privilege($1, 'TRUNCATE') AS truncate`,
      [table],
    );
    expect(rows[0]).toEqual({
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
        /consent_events is append-only/,
      );
    },
  );

  it('an unknown code or a self-assisted event is refused by its CHECKs', async () => {
    await expect(
      attempt(
        app,
        `INSERT INTO consent_events (id, tenant_id, account_id, code, version,
           action, actor_type, actor_account_id)
         VALUES ('${newId()}', '${tenantId}', '${accountId}', 'marketing', 1,
           'grant', 'account', '${accountId}')`,
      ),
    ).rejects.toThrow(/consent_events_code_known/);
    await expect(
      attempt(
        app,
        `INSERT INTO consent_events (id, tenant_id, account_id, code, version,
           action, actor_type, actor_account_id, assisted, assist_reason_code)
         VALUES ('${newId()}', '${tenantId}', '${accountId}', 'ticket_phone_share', 1,
           'grant', 'account', '${accountId}', true, 'phone_call')`,
      ),
    ).rejects.toThrow(/consent_events_actor_shape/);
  });

  it('the row is still there', async () => {
    const { rows } = await attempt(
      migrator,
      `SELECT count(*)::int AS n FROM ${table} WHERE id = '${id}'`,
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});
