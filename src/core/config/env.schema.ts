import { z } from 'zod';

/** Unset and empty (`KEY=` in .env) mean the same thing: not configured. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string');

const secret = z.string().min(32, 'must be at least 32 characters');

const positiveInt = z.coerce.number().int().positive();

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: positiveInt.default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    CORS_ORIGINS: z.string().default(''),
    /**
     * Number of reverse-proxy hops to trust for the client IP (e.g. 1 behind
     * one nginx), or false. Never "trust everything": clients could forge
     * X-Forwarded-For to spoof audit IPs and dodge per-IP rate limits.
     */
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v, ctx) => {
        if (v === 'false' || v === '' || v === '0') return false;
        if (/^[1-9]\d?$/.test(v)) return Number(v);
        ctx.addIssue({
          code: 'custom',
          message: 'must be false or a number of proxy hops (e.g. 1)',
        });
        return z.NEVER;
      }),

    DATABASE_URL: postgresUrl,
    DB_POOL_MAX: positiveInt.default(10),
    /**
     * Database-side cap (statement_timeout) on each security event insert. A
     * locked or stalled security_events table costs a login at most this much,
     * and the connection goes back to the pool (ADR 0014).
     */
    SECURITY_EVENT_TIMEOUT_MS: positiveInt.default(500),

    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// URL'),

    // Object storage (ADR 0029): Cloudflare R2 in production, MinIO in
    // development, CI and tests; any S3 API works. The bucket is private:
    // uploads and reads go through short-lived presigned URLs.
    /** R2: https://<account>.r2.cloudflarestorage.com. Unset = AWS. */
    S3_ENDPOINT: optional(z.url()),
    /** R2: `auto`. MinIO: `us-east-1`. */
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    /** Path-style URLs (endpoint/bucket/key): MinIO needs them, R2 accepts them. */
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Lifetime of a presigned upload or read URL. Files hold personal data: keep it short. */
    S3_URL_TTL_SECONDS: positiveInt.max(3600).default(300),

    SMTP_HOST: z.string().min(1),
    SMTP_PORT: positiveInt,
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: optional(z.string()),
    SMTP_PASSWORD: optional(z.string()),
    SMTP_FROM: z.string().min(1),

    // Email outbox (ADR 0019)
    OUTBOX_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    OUTBOX_POLL_MS: positiveInt.default(5000),
    OUTBOX_MAX_ATTEMPTS: positiveInt.default(8),
    OUTBOX_RETENTION_DAYS: positiveInt.default(30),

    // The in-app sweep (Phase 2.2): majority notices, registration expiry,
    // overdue erasures.
    SWEEP_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SWEEP_INTERVAL_MS: positiveInt.default(3_600_000),
    // A self-registration nobody decided expires after this (ADR 0024).
    REGISTRATION_PENDING_DAYS: positiveInt.default(30),
    // Account deletion (ADR 0023): undo window, then how long an erasure
    // may wait before the erasure holders are told.
    DELETION_GRACE_DAYS: positiveInt.default(30),
    ERASURE_OVERDUE_DAYS: positiveInt.default(7),
    // The gate (ADR 0028): someone "inside" this long gets an unconfirmed
    // exit; verify attempts per guard per minute.
    GATE_UNCONFIRMED_EXIT_HOURS: positiveInt.default(12),
    GATE_VERIFY_RATE_LIMIT_PER_MINUTE: positiveInt.default(30),
    // Parcel code checks per guard per minute (ADR 0035): a budget of its
    // own, so parcels and passes do not starve each other.
    PARCEL_CODE_RATE_LIMIT_PER_MINUTE: positiveInt.default(30),
    /**
     * The web app visitors open (ADR 0030): a pass's link is
     * `<PUBLIC_APP_URL>/v#<token>`. https in production; no trailing slash.
     */
    PUBLIC_APP_URL: z
      .string()
      .regex(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/, 'must be an http(s) URL')
      .transform((v) => v.replace(/\/+$/, '')),
    // The public visitor page (ADR 0030): requests per minute per IP and per link.
    VISITOR_PAGE_RATE_LIMIT_PER_IP: positiveInt.default(60),
    VISITOR_PAGE_RATE_LIMIT_PER_TOKEN: positiveInt.default(20),
    // Read notifications are deleted after this (ADR 0027).
    NOTIFICATIONS_RETENTION_DAYS: positiveInt.default(90),
    // A worker's photo is deleted once no engagement of theirs has been
    // open for this long (ADR 0029).
    WORKER_PHOTO_RETENTION_DAYS: positiveInt.default(90),

    JWT_ACCESS_SECRET: secret,
    IDENTIFIER_PEPPER: secret,
    /**
     * Derives every resident's entry secret (ADR 0031). Whoever holds it can
     * forge a resident QR in every compound; rotating it invalidates every
     * entry credential. Must differ from IDENTIFIER_PEPPER and from
     * environment to environment.
     */
    ENTRY_CREDENTIAL_KEY: secret,
    /**
     * Derives the token behind every parcel code and QR (ADR 0035). Whoever
     * holds it and a credential id can compute that credential's code;
     * rotating it strands the codes of the parcels held at the time. Must
     * differ from IDENTIFIER_PEPPER and ENTRY_CREDENTIAL_KEY, and from
     * environment to environment.
     */
    PARCEL_TOKEN_KEY: secret,
    OTP_TTL_SECONDS: positiveInt.default(300),
    OTP_MAX_ATTEMPTS: positiveInt.default(5),
    LOGIN_TICKET_TTL_SECONDS: positiveInt.default(300),
    OTP_RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(900),
    OTP_RATE_LIMIT_PER_IDENTIFIER: positiveInt.default(5),
    OTP_RATE_LIMIT_PER_IP: positiveInt.default(20),

    // Platform super admin (ADR 0011)
    PLATFORM_JWT_SECRET: secret,
    SUPERADMIN_EMAIL: optional(z.email()),
    SUPERADMIN_PASSWORD: optional(
      z.string().min(12, 'must be at least 12 characters'),
    ),
    PLATFORM_LOGIN_MAX_FAILURES: positiveInt.default(5),
    PLATFORM_LOCKOUT_SECONDS: positiveInt.default(900),
    PLATFORM_LOGIN_RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(900),
    PLATFORM_LOGIN_RATE_LIMIT_PER_IP: positiveInt.default(20),
    PLATFORM_LOGIN_RATE_LIMIT_PER_EMAIL: positiveInt.default(10),

    /** Development only: every OTP becomes this code. See the refinement below. */
    OTP_FIXED_CODE: optional(
      z.string().regex(/^\d{6}$/, 'must be exactly 6 digits'),
    ),
  })
  .superRefine((env, ctx) => {
    // Separate secrets keep tenant and platform tokens mutually unforgeable.
    if (env.PLATFORM_JWT_SECRET === env.JWT_ACCESS_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['PLATFORM_JWT_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
    // One key must not open two doors: the pepper hashes login identifiers
    // and codes, this one forges resident QRs (ADR 0031).
    if (env.ENTRY_CREDENTIAL_KEY === env.IDENTIFIER_PEPPER) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENTRY_CREDENTIAL_KEY'],
        message: 'must differ from IDENTIFIER_PEPPER',
      });
    }
    // The parcel key derives codes: it must not also be the pepper that
    // hashes them, nor the key that forges resident QRs (ADR 0035).
    if (env.PARCEL_TOKEN_KEY === env.IDENTIFIER_PEPPER) {
      ctx.addIssue({
        code: 'custom',
        path: ['PARCEL_TOKEN_KEY'],
        message: 'must differ from IDENTIFIER_PEPPER',
      });
    }
    if (env.PARCEL_TOKEN_KEY === env.ENTRY_CREDENTIAL_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['PARCEL_TOKEN_KEY'],
        message: 'must differ from ENTRY_CREDENTIAL_KEY',
      });
    }
    if (
      (env.SUPERADMIN_EMAIL === undefined) !==
      (env.SUPERADMIN_PASSWORD === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPERADMIN_PASSWORD'],
        message:
          'SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD must be set together',
      });
    }
    // A visitor's link carries a secret in its fragment: never over http.
    if (
      env.NODE_ENV === 'production' &&
      !env.PUBLIC_APP_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_APP_URL'],
        message: 'must be https:// when NODE_ENV=production',
      });
    }
    // A fixed code in production is a universal password. Refuse to boot
    // rather than trust that someone remembers to unset it.
    if (env.NODE_ENV === 'production' && env.OTP_FIXED_CODE !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_FIXED_CODE'],
        message: 'must not be set when NODE_ENV=production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Plugged into ConfigModule.forRoot({ validate }); a throw aborts startup. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
