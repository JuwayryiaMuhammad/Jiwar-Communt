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

    DATABASE_URL: postgresUrl,
    DB_POOL_MAX: positiveInt.default(10),

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

    JWT_ACCESS_SECRET: secret,
    IDENTIFIER_PEPPER: secret,
    OTP_TTL_SECONDS: positiveInt.default(300),
    OTP_MAX_ATTEMPTS: positiveInt.default(5),
    LOGIN_TICKET_TTL_SECONDS: positiveInt.default(300),
    OTP_RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(900),
    OTP_RATE_LIMIT_PER_IDENTIFIER: positiveInt.default(5),
    OTP_RATE_LIMIT_PER_IP: positiveInt.default(20),

    /** Development only: every OTP becomes this code. See the refinement below. */
    OTP_FIXED_CODE: optional(
      z.string().regex(/^\d{6}$/, 'must be exactly 6 digits'),
    ),
  })
  .superRefine((env, ctx) => {
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
