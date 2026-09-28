import { config } from 'dotenv';

/**
 * Point the process at the test database and the test Redis db, and make
 * sure the dev-only fixed OTP is off: the login tests must exercise real code
 * generation and read the codes from Mailpit.
 */
export function applyTestEnv(): void {
  config({ quiet: true });
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'error';
  process.env.DATABASE_URL = required('TEST_DATABASE_URL');
  process.env.MIGRATOR_DATABASE_URL = required('TEST_MIGRATOR_DATABASE_URL');
  process.env.REDIS_URL = required('TEST_REDIS_URL');
  delete process.env.OTP_FIXED_CODE;
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} must be set for e2e tests (see .env.example)`);
  return value;
}
