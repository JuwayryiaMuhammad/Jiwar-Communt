import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { required } from '../setup/test-env';

/**
 * ADR 0032, 0033: a ticket's status history and assignment trail, the
 * availability history and the dispatch attempts are append-only like
 * gate_entries (ADR 0028): rows can be inserted and read, never changed
 * or removed — not by the app, not by the table owner.
 */
describe.each([
  {
    table: 'ticket_status_history',
    insert: (id: string, tenantId: string) =>
      `INSERT INTO ticket_status_history (id, tenant_id, ticket_id, from_status,
         to_status, actor_account_id, cycle)
       VALUES ('${id}', '${tenantId}', '${newId()}', 'new', 'assigned',
         '${newId()}', 1)`,
    update: 'SET reason_code = $$x$$',
  },
  {
    table: 'ticket_assignments',
    insert: (id: string, tenantId: string) =>
      `INSERT INTO ticket_assignments (id, tenant_id, ticket_id, to_account_id,
         assigned_by_account_id, assignment_type, cycle)
       VALUES ('${id}', '${tenantId}', '${newId()}', '${newId()}',
         '${newId()}', 'manual', 1)`,
    update: 'SET reason_code = $$x$$',
  },
  {
    table: 'technician_availability_history',
    insert: (id: string, tenantId: string) =>
      `INSERT INTO technician_availability_history (id, tenant_id, account_id,
         from_state, to_state, changed_by_account_id, reason_code)
       VALUES ('${id}', '${tenantId}', '${newId()}', NULL, 'available',
         '${newId()}', 'sick')`,
    update: 'SET reason_code = $$x$$',
  },
  {
    table: 'ticket_dispatch_attempts',
    insert: (id: string, tenantId: string) =>
      `INSERT INTO ticket_dispatch_attempts (id, tenant_id, ticket_id, cycle,
         trigger, outcome, candidate_count, technician_account_id)
       VALUES ('${id}', '${tenantId}', '${newId()}', 1, 'created', 'assigned',
         2, '${newId()}')`,
    update: 'SET candidate_count = 9',
  },
])('$table is immutable', ({ table, insert, update: set }) => {
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
    await attempt(app, insert(id, tenantId));
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

  const update = () => `UPDATE ${table} ${set} WHERE id = '${id}'`;
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
});
