import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { required } from '../setup/test-env';

/**
 * ADR 0035: the parcel event log is append-only like gate_entries (ADR 0028)
 * and the ticket history (ADR 0032): rows can be inserted and read, never
 * changed or removed — not by the app, not by the table owner.
 */
describe('parcel_events is immutable', () => {
  const table = 'parcel_events';
  let app: Client;
  let migrator: Client;
  const tenantId = newId();
  const id = newId();

  beforeAll(async () => {
    app = new Client({ connectionString: process.env.DATABASE_URL });
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await app.connect();
    await migrator.connect();
    await attempt(
      app,
      `INSERT INTO parcel_events (id, tenant_id, parcel_id, kind, actor_side,
         actor_account_id)
       VALUES ('${id}', '${tenantId}', '${newId()}', 'received', 'guard',
         '${newId()}')`,
    );
  });

  afterAll(async () => {
    await app.end();
    await migrator.end();
  });

  /** Runs `sql` as `client` inside the row's tenant (FORCE RLS). */
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

  const update = () =>
    `UPDATE ${table} SET reason_code = 'other' WHERE id = '${id}'`;
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
        new RegExp(`${table} is append-only`),
      );
    },
  );

  it('jiwar_app cannot disable the trigger', async () => {
    await expect(
      app.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`),
    ).rejects.toThrow(/must be owner/);
  });

  it('the row is still there', async () => {
    const { rows } = await attempt(
      migrator,
      `SELECT count(*)::int AS n FROM ${table} WHERE id = '${id}'`,
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('a system event has no account, and a human one has', async () => {
    await expect(
      attempt(
        migrator,
        `INSERT INTO parcel_events (id, tenant_id, parcel_id, kind, actor_side)
         VALUES ('${newId()}', '${tenantId}', '${newId()}', 'received', 'guard')`,
      ),
    ).rejects.toThrow(/parcel_events_system_has_no_account/);
  });
});
