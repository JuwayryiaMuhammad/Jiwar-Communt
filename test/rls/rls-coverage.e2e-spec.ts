import { Client } from 'pg';

/**
 * Every table with a `tenant_id` column is tenant data and must be protected
 * exactly like the Phase 0 tables (ADR 0005). New tenant tables are covered
 * automatically: forgetting the RLS block in a migration fails here.
 */

/**
 * Global tables that carry tenant_id as a pointer, not as ownership. They
 * are read before a tenant is known (login) and reached only through
 * GlobalDbService. Adding a table here is a design decision.
 */
const GLOBAL_WITH_TENANT_ID = ['login_identifiers', 'sessions'];

const EXPECTED =
  "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";

describe('RLS coverage', () => {
  let c: Client;

  beforeAll(async () => {
    c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
  });

  afterAll(() => c.end());

  async function tablesWithTenantId(): Promise<string[]> {
    const { rows } = await c.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id'
       ORDER BY table_name`);
    return rows.map((r) => r.table_name);
  }

  it('the global exceptions still exist (the list cannot rot)', async () => {
    const tables = await tablesWithTenantId();
    for (const t of GLOBAL_WITH_TENANT_ID) expect(tables).toContain(t);
  });

  it('every other table with tenant_id has RLS, FORCE and the tenant_isolation policy', async () => {
    const tenantTables = (await tablesWithTenantId()).filter(
      (t) => !GLOBAL_WITH_TENANT_ID.includes(t),
    );
    expect(tenantTables.length).toBeGreaterThanOrEqual(6);

    const { rows } = await c.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.qual, p.with_check
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         LEFT JOIN pg_policies p
           ON p.schemaname = 'public' AND p.tablename = c.relname
          AND p.policyname = 'tenant_isolation'
        WHERE c.relname = ANY($1)`,
      [tenantTables],
    );

    const problems = tenantTables.flatMap((table) => {
      const r = rows.find((x) => x.relname === table);
      if (!r) return [`${table}: not found`];
      return [
        ...(r.relrowsecurity ? [] : [`${table}: RLS not enabled`]),
        ...(r.relforcerowsecurity ? [] : [`${table}: FORCE not set`]),
        ...(r.qual === EXPECTED ? [] : [`${table}: USING is ${r.qual}`]),
        ...(r.with_check === EXPECTED
          ? []
          : [`${table}: WITH CHECK is ${r.with_check}`]),
      ];
    });
    expect(problems).toEqual([]);
  });

  it('no table has a permissive policy besides tenant_isolation', async () => {
    const { rows } = await c.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
        WHERE schemaname = 'public' AND policyname <> 'tenant_isolation'`,
    );
    expect(rows).toEqual([]);
  });
});
