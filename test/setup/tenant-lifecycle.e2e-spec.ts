import { Client } from 'pg';
import { TenantLifecycle } from '../../src/core/tenant-settings/tenant-lifecycle';
import { createDbHarness, type DbHarness } from './db-module';
import { createTenant, tenantLifecycle } from './fixtures';
import { createHttpHarness, type HttpHarness } from './http-app';
import { required } from './test-env';

/**
 * fixtures.ts wires its own TenantLifecycle for the harnesses that boot core
 * only. It must register exactly what the full AppModule registers, so a new
 * domain's onCreated cannot be forgotten there: a compound it creates would
 * lack that domain's rows, and the suites using it would pass against a
 * compound no real one resembles.
 */
describe('Test harness — TenantLifecycle', () => {
  let app: HttpHarness;
  let core: DbHarness;
  let sql: Client;

  beforeAll(async () => {
    app = await createHttpHarness();
    core = await createDbHarness();
    sql = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await sql.connect();
  }, 60_000);

  afterAll(async () => {
    await sql.end();
    await core.close();
    await app.close();
  });

  /** The registered handlers (private: there is no reason to expose them). */
  const handlerCount = (l: TenantLifecycle) =>
    (l as unknown as { created: unknown[] }).created.length;

  it('registers as many handlers as the full app does', () => {
    expect(handlerCount(tenantLifecycle)).toBeGreaterThan(0);
    expect(handlerCount(tenantLifecycle)).toBe(
      handlerCount(app.moduleRef.get(TenantLifecycle)),
    );
  });

  /** Rows per tenant-scoped table (superuser: RLS does not apply). */
  async function rowsOf(tenantId: string): Promise<Record<string, number>> {
    const { rows: tables } = await sql.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`,
    );
    const counts: Record<string, number> = {};
    for (const { table_name } of tables) {
      const { rows } = await sql.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${table_name}" WHERE tenant_id = $1`,
        [tenantId],
      );
      counts[table_name] = Number(rows[0].n);
    }
    return counts;
  }

  it('gives a core-only compound the same rows as a compound of the full app', async () => {
    const fromApp = await rowsOf((await app.createTenant('Lifecycle app')).id);
    const fromCore = await rowsOf(await createTenant(core, 'Lifecycle core'));
    // The comparison means something: the domains' rows are in it.
    expect(fromApp.maintenance_settings).toBe(1);
    expect(fromApp.ticket_categories).toBeGreaterThan(0);
    expect(fromApp.parcel_settings).toBe(1);
    expect(fromApp.parcel_counters).toBe(1);
    expect(fromCore).toEqual(fromApp);
  });
});
