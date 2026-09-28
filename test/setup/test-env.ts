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
  // Codes are read back from Mailpit, whatever SMTP the developer uses for
  // local runs (a real provider in .env must never receive test emails).
  process.env.SMTP_HOST = process.env.TEST_SMTP_HOST ?? '127.0.0.1';
  process.env.SMTP_PORT = process.env.TEST_SMTP_PORT ?? '1025';
  process.env.SMTP_SECURE = 'false';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  // Every test request comes from 127.0.0.1, so the per-IP limit would trip
  // across unrelated tests. The per-identifier limit keeps its real value and
  // is what the rate-limit test exercises.
  process.env.OTP_RATE_LIMIT_PER_IP = '100000';
  process.env.OTP_RATE_LIMIT_PER_IDENTIFIER = '5';
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} must be set for e2e tests (see .env.example)`);
  return value;
}
