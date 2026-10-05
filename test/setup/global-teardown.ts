import { Client } from 'pg';
import { applyTestEnv, required } from './test-env';

/**
 * Once per run, after every suite: no active compound may lack what every
 * real compound gets from TenantsService.provision and the migrations'
 * backfills. A compound missing its maintenance rows makes every sweep fail
 * on it, which would hide a real failure among expected ones. A test that
 * needs a raw tenant row (an old compound, with old roles) still gives it the
 * domains' rows through TenantLifecycle, as the migrations' backfills did.
 */
export default async function globalTeardown(): Promise<void> {
  applyTestEnv();
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    const { rows } = await db.query<{ name: string; missing: string }>(
      `SELECT t.name,
              concat_ws(', ',
                CASE WHEN ms.tenant_id IS NULL THEN 'maintenance_settings' END,
                CASE WHEN ds.tenant_id IS NULL THEN 'maintenance_dispatch_settings' END,
                CASE WHEN ss.tenant_id IS NULL THEN 'maintenance_sla_settings' END
              ) AS missing
         FROM tenants t
         LEFT JOIN maintenance_settings ms ON ms.tenant_id = t.id
         LEFT JOIN maintenance_dispatch_settings ds ON ds.tenant_id = t.id
         LEFT JOIN maintenance_sla_settings ss ON ss.tenant_id = t.id
        WHERE t.status = 'active'
          AND (ms.tenant_id IS NULL OR ds.tenant_id IS NULL OR ss.tenant_id IS NULL)
        ORDER BY t.created_at`,
    );
    if (rows.length)
      throw new Error(
        `${rows.length} active compound(s) without their maintenance rows; ` +
          `create test compounds through the harness, or call TenantLifecycle.tenantCreated: ` +
          rows
            .slice(0, 10)
            .map((r) => `${r.name} (${r.missing})`)
            .join('; '),
      );
  } finally {
    await db.end();
  }
}
