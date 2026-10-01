import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { required } from '../setup/test-env';

/**
 * ADR 0028: the gate log is append-only like the audit tables (ADR 0014):
 * rows can be inserted and read, never changed or removed — not by the
 * app, not by the table owner. A correction is a new entry.
 */
describe('gate_entries is immutable', () => {
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
      `INSERT INTO gate_entries (id, tenant_id, gate_id, shift_id, guard_account_id,
         subject_type, subject_id, unit_id, direction, method, occurred_at)
       VALUES ('${id}', '${tenantId}', '${newId()}', '${newId()}', '${newId()}',
         'visitor_pass', '${newId()}', '${newId()}', 'in', 'code', now())`,
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

  const update = `UPDATE gate_entries SET unconfirmed = false WHERE id = '${id}'`;
  const remove = `DELETE FROM gate_entries WHERE id = '${id}'`;
  const truncate = 'TRUNCATE gate_entries';

  it('jiwar_app has only SELECT and INSERT', async () => {
    const { rows } = await app.query<Record<string, boolean>>(
      `SELECT has_table_privilege('gate_entries', 'SELECT') AS select,
              has_table_privilege('gate_entries', 'INSERT') AS insert,
              has_table_privilege('gate_entries', 'UPDATE') AS update,
              has_table_privilege('gate_entries', 'DELETE') AS delete,
              has_table_privilege('gate_entries', 'TRUNCATE') AS truncate`,
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
    await expect(attempt(app, sql)).rejects.toThrow(/permission denied/);
  });

  it.each([
    ['UPDATE', update],
    ['DELETE', remove],
    ['TRUNCATE', truncate],
  ])(
    'jiwar_migrator (the owner): %s is rejected by the trigger',
    async (_op, sql) => {
      await expect(attempt(migrator, sql)).rejects.toThrow(
        /gate entries are immutable/,
      );
    },
  );

  it('jiwar_app cannot disable the trigger', async () => {
    await expect(
      app.query('ALTER TABLE gate_entries DISABLE TRIGGER USER'),
    ).rejects.toThrow(/must be owner/);
  });

  it('the row is still there', async () => {
    const { rows } = await attempt(
      migrator,
      `SELECT count(*)::int AS n FROM gate_entries WHERE id = '${id}'`,
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});
