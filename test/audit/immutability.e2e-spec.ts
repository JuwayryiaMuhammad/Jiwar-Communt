import { Client } from 'pg';
import { newId } from '../../src/common/uuid';
import { required } from '../setup/test-env';

/**
 * ADR 0014: audit rows can be inserted and read, never changed or removed —
 * not by the app, not by the table owner.
 */
const TABLES = ['audit_log', 'platform_audit_log', 'security_events'] as const;

describe('Audit tables are immutable', () => {
  let app: Client;
  let migrator: Client;
  const tenantId = newId();
  const ids: Record<(typeof TABLES)[number], string> = {
    audit_log: newId(),
    platform_audit_log: newId(),
    security_events: newId(),
  };

  beforeAll(async () => {
    app = new Client({ connectionString: process.env.DATABASE_URL });
    migrator = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await app.connect();
    await migrator.connect();

    // One row per table, inserted as the app (the tenant table needs its tenant).
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await app.query(
      `INSERT INTO audit_log (id, tenant_id, actor_type, action, target_type)
       VALUES ($1, $2, 'system', 'unit.created', 'unit')`,
      [ids.audit_log, tenantId],
    );
    await app.query('COMMIT');
    await app.query(
      `INSERT INTO platform_audit_log (id, actor_type, action, target_type)
       VALUES ($1, 'system', 'tenant.created', 'tenant')`,
      [ids.platform_audit_log],
    );
    await app.query(
      `INSERT INTO security_events (id, event) VALUES ($1, 'otp.requested')`,
      [ids.security_events],
    );
  });

  afterAll(async () => {
    await app.end();
    await migrator.end();
  });

  /** Runs `sql` as `client`, inside the audit row's tenant for audit_log. */
  async function attempt(client: Client, table: string, sql: string) {
    await client.query('BEGIN');
    try {
      if (table === 'audit_log') {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
      }
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  describe.each(TABLES)('%s', (table) => {
    const update = () =>
      `UPDATE ${table} SET metadata = '{}'::jsonb WHERE id = '${ids[table]}'`;
    const remove = () => `DELETE FROM ${table} WHERE id = '${ids[table]}'`;
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
      await expect(attempt(app, table, sql())).rejects.toThrow(
        /permission denied/,
      );
    });

    it.each([
      ['UPDATE', update],
      ['DELETE', remove],
      ['TRUNCATE', truncate],
    ])(
      'jiwar_migrator (the owner): %s is rejected by the trigger',
      async (_op, sql) => {
        await expect(attempt(migrator, table, sql())).rejects.toThrow(
          /audit rows are immutable/,
        );
      },
    );

    it('jiwar_app cannot disable the trigger', async () => {
      await expect(
        app.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`),
      ).rejects.toThrow(/must be owner/);
    });

    it('the row is still there, unchanged', async () => {
      // FORCE RLS applies to the owner too: read audit_log inside its tenant.
      await migrator.query('BEGIN');
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          tenantId,
        ]);
        const { rows } = await migrator.query<{ metadata: unknown }>(
          `SELECT metadata FROM ${table} WHERE id = $1`,
          [ids[table]],
        );
        expect(rows).toEqual([{ metadata: null }]);
      } finally {
        await migrator.query('ROLLBACK');
      }
    });
  });

  it('only the system actor may have no actor id', async () => {
    await expect(
      app.query(
        `INSERT INTO platform_audit_log (id, actor_type, action, target_type)
         VALUES ($1, 'platform_admin', 'tenant.created', 'tenant')`,
        [newId()],
      ),
    ).rejects.toThrow(/actor_id_matches_type/);
    await expect(
      app.query(
        `INSERT INTO platform_audit_log (id, actor_type, actor_id, action, target_type)
         VALUES ($1, 'system', $2, 'tenant.created', 'tenant')`,
        [newId(), newId()],
      ),
    ).rejects.toThrow(/actor_id_matches_type/);
  });
});
