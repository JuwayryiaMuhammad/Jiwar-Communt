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

  const redis = new Redis(required('TEST_REDIS_URL'));
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

/** Every table except the migration history. TRUNCATE is not subject to RLS. */
async function truncateAll(migratorUrl: string): Promise<void> {
  const db = new Client({ connectionString: migratorUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
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
