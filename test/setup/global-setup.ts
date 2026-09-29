import { execSync } from 'node:child_process';
import Redis from 'ioredis';
import { Client } from 'pg';
import { applyTestEnv, required } from './test-env';

/**
 * Once per run: migrate the test database AS THE MIGRATOR (exactly like a
 * deploy), then wipe data and the test Redis db. Tests themselves only ever
 * connect as jiwar_app.
 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  const migratorUrl = required('TEST_MIGRATOR_DATABASE_URL');

  // Wipe data BEFORE migrating too: a new migration may add NOT NULL columns
  // that rows left by the previous run could not satisfy.
  await truncateAll(migratorUrl);

  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, MIGRATOR_DATABASE_URL: migratorUrl },
    stdio: 'pipe',
  });

  await truncateAll(migratorUrl);
  await clearAuditTables(required('TEST_SUPERUSER_DATABASE_URL'));

  // Permission sync is a deploy step (ADR 0010); run it like a deploy would.
  execSync('pnpm access:sync', { env: process.env, stdio: 'pipe' });

  const redis = new Redis(required('TEST_REDIS_URL'));
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

/**
 * Immutable audit tables (ADR 0014): TRUNCATE is rejected by a trigger for
 * every role, so they are cleared separately over a superuser connection.
 */
const AUDIT_TABLES = ['audit_log', 'platform_audit_log', 'security_events'];

/**
 * Test-only. `session_replication_role = replica` skips ordinary triggers,
 * including the immutability ones; it needs a superuser and must never appear
 * outside test/ (a unit test enforces that).
 */
async function clearAuditTables(superuserUrl: string): Promise<void> {
  const db = new Client({ connectionString: superuserUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [AUDIT_TABLES],
    );
    if (!rows.length) return;
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')}`,
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

/** Every table except the migration history and the audit tables. TRUNCATE is not subject to RLS. */
async function truncateAll(migratorUrl: string): Promise<void> {
  const db = new Client({ connectionString: migratorUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
          AND tablename <> ALL($1)`,
      [AUDIT_TABLES],
    );
    if (rows.length) {
      await db.query(
        `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`,
      );
    }
  } finally {
    await db.end();
  }
}
