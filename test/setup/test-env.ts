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
  // Same for object storage: files go to the local MinIO's test bucket,
  // never to a real bucket the developer's .env may point at (ADR 0029).
  process.env.S3_ENDPOINT =
    process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9005';
  process.env.S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'jiwar-test';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_FORCE_PATH_STYLE = 'true';
  process.env.S3_ACCESS_KEY_ID =
    process.env.TEST_S3_ACCESS_KEY_ID ?? 'jiwar_minio';
  process.env.S3_SECRET_ACCESS_KEY =
    process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'jiwar_minio_dev';
  // Every test request comes from 127.0.0.1, so the per-IP limit would trip
  // across unrelated tests. The per-identifier limit keeps its real value and
  // is what the rate-limit test exercises.
  process.env.OTP_RATE_LIMIT_PER_IP = '100000';
  process.env.OTP_RATE_LIMIT_PER_IDENTIFIER = '5';
  process.env.PLATFORM_LOGIN_RATE_LIMIT_PER_IP = '100000';
  // Same for the public visitor page (ADR 0030); its per-link limit is real.
  process.env.VISITOR_PAGE_RATE_LIMIT_PER_IP = '100000';
  process.env.VISITOR_PAGE_RATE_LIMIT_PER_TOKEN = '20';
  process.env.PUBLIC_APP_URL = 'https://app.jiwar.test';
  process.env.PLATFORM_LOGIN_RATE_LIMIT_PER_EMAIL = '10';
  process.env.PLATFORM_LOGIN_MAX_FAILURES = '5';
  // Tests drain the outbox explicitly (processDue), so a poller of one suite
  // never takes another suite's messages (ADR 0019).
  process.env.OUTBOX_ENABLED = 'false';
  // Same for the sweep: suites call SweepRunner.run(name, now) themselves.
  process.env.SWEEP_ENABLED = 'false';
  // The locked-table test measures against the default cap.
  process.env.SECURITY_EVENT_TIMEOUT_MS = '500';
  // Platform tests create their own admins; nothing is bootstrapped from .env.
  delete process.env.SUPERADMIN_EMAIL;
  delete process.env.SUPERADMIN_PASSWORD;
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} must be set for e2e tests (see .env.example)`);
  return value;
}
