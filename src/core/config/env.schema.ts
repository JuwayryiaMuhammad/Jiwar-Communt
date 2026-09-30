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

    JWT_ACCESS_SECRET: secret,
    IDENTIFIER_PEPPER: secret,
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
