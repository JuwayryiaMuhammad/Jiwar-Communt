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

  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, MIGRATOR_DATABASE_URL: migratorUrl },
    stdio: 'pipe',
  });

  const db = new Client({ connectionString: migratorUrl });
  await db.connect();
  try {
    // TRUNCATE is not subject to RLS; the owner may run it.
    await db.query(
      'TRUNCATE sessions, otp_challenges, login_identifiers, units, accounts, tenants CASCADE',
    );
  } finally {
    await db.end();
  }

  const redis = new Redis(required('TEST_REDIS_URL'));
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
