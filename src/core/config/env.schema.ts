import { z } from 'zod';
import { fcmServiceAccount } from './fcm-service-account';
import {
  decodeSeed,
  parsePreviousPublicKeys,
  SIGNING_KEY_VERSION_MAX,
} from './bundle-signing-keys';
import {
  ENGAGEMENT_KEY_VERSION_MAX,
  parseEngagementTokenKeys,
} from './engagement-token-keys';
import {
  decodePaymentKey,
  PAYMENT_KEY_VERSION_MAX,
  parsePreviousPaymentKeys,
} from './payment-key-ring';
import { VENDOR_DRIVER_CHOICES, VENDOR_DRIVER_VARS } from './vendor-drivers';

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

    // Push notifications through Firebase Cloud Messaging (ADR 0041), from
    // the Firebase service account. All three unset: push is off, nothing is
    // queued, everything else works.
    FCM_PROJECT_ID: optional(z.string().min(1)),
    FCM_CLIENT_EMAIL: optional(z.string().min(1)),
    /** The PEM, its newlines written as `\n`. A secret: never logged. */
    FCM_PRIVATE_KEY: optional(z.string().min(1)),
    PUSH_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    PUSH_POLL_MS: positiveInt.default(5000),
    PUSH_MAX_ATTEMPTS: positiveInt.default(5),

    // The in-app sweep (Phase 2.2): majority notices, registration expiry,
    // account deletions (ADR 0036).
    SWEEP_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SWEEP_INTERVAL_MS: positiveInt.default(3_600_000),
    // A self-registration nobody decided expires after this (ADR 0024).
    REGISTRATION_PENDING_DAYS: positiveInt.default(30),
    // Account deletion (ADR 0023, 0036): the cooling-off, after which the
    // sweep erases the account (or queues the request when it is blocked).
    DELETION_GRACE_DAYS: positiveInt.default(14),
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
    // A registrant's status link (ADR 0062): requests per minute per IP and per link.
    REGISTRATION_STATUS_RATE_LIMIT_PER_IP: positiveInt.default(30),
    REGISTRATION_STATUS_RATE_LIMIT_PER_TOKEN: positiveInt.default(20),
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
    /**
     * Keys the opaque references of the community life (ADR 0040): which
     * ballot is a unit's while a poll is open, and the marks that count an
     * announcement's readers. The database holds no way from a unit to its
     * choice without it. Rotating it while a poll is open orphans the
     * ballots already cast, and readers are counted again. Must differ
     * from the other keys, and from environment to environment.
     */
    ENGAGEMENT_REF_SECRET: z
      .string({
        error:
          'is required (ADR 0040): generate one with `openssl rand -base64 48`',
      })
      .min(32, 'must be at least 32 characters'),
    /**
     * Derives the token behind every visitor pass's code, QR and link
     * (ADR 0043), so the host can see them again while the server stores
     * only their HMACs. Whoever holds it and a pass id can compute that
     * pass's code; rotating it hides the codes of the passes active at the
     * time (they still work: their hashes are stored). Must differ from the
     * other keys, and from environment to environment.
     */
    VISITOR_PASS_TOKEN_KEY: z
      .string({
        error:
          'is required (ADR 0043): generate one with `openssl rand -base64 48`',
      })
      .min(32, 'must be at least 32 characters'),
    /**
     * Derives the token behind every worker card's code and QR (ADR 0057),
     * so the gate's offline bundle can carry what a device needs to know a
     * card while the server stores only their HMACs: `ver:key[,ver:key]`,
     * each key at least 32 characters. Whoever holds a key and an
     * engagement id can compute that card. A rotation adds a version and
     * raises ENGAGEMENT_TOKEN_KEY_VERSION: new and reissued cards take it,
     * printed ones keep theirs, so an old key leaves the ring only once no
     * live card was derived with it. Every key differs from the other
     * secrets, and from environment to environment.
     */
    ENGAGEMENT_TOKEN_KEYS: z.string({
      error:
        'is required (ADR 0057): `1:<key>`, a key from `openssl rand -base64 48`',
    }),
    /**
     * Signs every gate bundle a guard device downloads (ADR 0057): the
     * 32-byte seed of an Ed25519 key, base64url or base64
     * (`openssl rand -base64 32`). Whoever holds it can make a bundle a
     * device trusts. Its version is the key id a bundle carries; a rotation
     * raises it and moves the old key's PUBLIC half to
     * GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS for a day (a bundle lives 24 h at
     * most). Differs from every other key, and from environment to
     * environment.
     */
    GATE_BUNDLE_SIGNING_KEY: z.string({
      error:
        'is required (ADR 0057): a 32-byte seed from `openssl rand -base64 32`',
    }),
    GATE_BUNDLE_SIGNING_KEY_VERSION: z.coerce
      .number()
      .int()
      .min(1)
      .max(SIGNING_KEY_VERSION_MAX)
      .default(1),
    /** Retired keys' public halves, verify only: `ver:key[,…]`. */
    GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS: optional(z.string()),
    /** The version new and reissued worker cards are derived with. */
    ENGAGEMENT_TOKEN_KEY_VERSION: z.coerce
      .number()
      .int()
      .min(1)
      .max(ENGAGEMENT_KEY_VERSION_MAX)
      .default(1),
    /**
     * Seals every compound's Paymob credentials and open checkout secrets
     * (ADR 0046): base64 of exactly 32 bytes (`openssl rand -base64 32`).
     * Optional while no compound takes online payment; the app refuses to
     * boot once one does and it is missing (FinanceBootCheck). Must differ
     * from the other keys, and from environment to environment.
     */
    PAYMENT_CREDENTIALS_KEY: optional(z.string()),
    /** The version new ciphertexts carry; raise it when the key rotates. */
    PAYMENT_CREDENTIALS_KEY_VERSION: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAYMENT_KEY_VERSION_MAX)
      .default(1),
    /** Retired keys, decrypt only, during a rotation: `ver:base64[,…]`. */
    PAYMENT_CREDENTIALS_PREVIOUS_KEYS: optional(z.string()),
    /**
     * The public HTTPS origin Paymob posts its notifications to (ADR 0046):
     * `<origin>/api/v1/public/payments/paymob/<compound id>`. No path, no
     * trailing slash. Required once a compound takes online payment.
     */
    PAYMENT_WEBHOOK_BASE_URL: optional(
      z
        .string()
        .regex(
          /^https?:\/\/[^\s/?#]+\/?$/,
          'must be an http(s) origin, without a path',
        )
        .transform((v) => v.replace(/\/+$/, '')),
    ),
    PAYMOB_BASE_URL: z
      .string()
      .regex(
        /^https?:\/\/[^\s/?#]+\/?$/,
        'must be an http(s) origin, without a path',
      )
      .transform((v) => v.replace(/\/+$/, ''))
      .default('https://accept.paymob.com'),
    PAYMOB_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(30000)
      .default(15000),
    /** How long a checkout stays open (ADR 0046). */
    PAYMENT_SESSION_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(10)
      .max(120)
      .default(30),
    // The public receipt page (ADR 0046): lookups per minute per IP.
    RECEIPT_PAGE_RATE_LIMIT_PER_IP: positiveInt.default(30),
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

    // Guard vendor adapters (ADR 0068): which driver each one runs. Unset is
    // the fake outside production and off in production; the fake is
    // refused in production (below). A real vendor's driver comes with its
    // contract, its credentials in the compound's vault, never here.
    GATE_FACE_DRIVER: optional(z.enum(VENDOR_DRIVER_CHOICES)),
    GATE_ID_SCAN_DRIVER: optional(z.enum(VENDOR_DRIVER_CHOICES)),
    GATE_CALL_DRIVER: optional(z.enum(VENDOR_DRIVER_CHOICES)),
    GATE_ALARM_DRIVER: optional(z.enum(VENDOR_DRIVER_CHOICES)),
    CONTROL_ROOM_DRIVER: optional(z.enum(VENDOR_DRIVER_CHOICES)),
    /** How long a vendor call may take before it is unavailable. */
    GATE_VENDOR_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30000)
      .default(5000),

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
    // The reference key hides who chose what (ADR 0040): it shares nothing
    // with the keys that hash identifiers or derive codes.
    for (const other of [
      'IDENTIFIER_PEPPER',
      'ENTRY_CREDENTIAL_KEY',
      'PARCEL_TOKEN_KEY',
    ] as const) {
      if (env.ENGAGEMENT_REF_SECRET === env[other]) {
        ctx.addIssue({
          code: 'custom',
          path: ['ENGAGEMENT_REF_SECRET'],
          message: `must differ from ${other}`,
        });
      }
    }
    // The pass key derives codes like the parcel key (ADR 0043): it shares
    // nothing with the keys that hash, forge or derive anything else.
    for (const other of [
      'IDENTIFIER_PEPPER',
      'ENTRY_CREDENTIAL_KEY',
      'PARCEL_TOKEN_KEY',
      'ENGAGEMENT_REF_SECRET',
    ] as const) {
      if (env.VISITOR_PASS_TOKEN_KEY === env[other]) {
        ctx.addIssue({
          code: 'custom',
          path: ['VISITOR_PASS_TOKEN_KEY'],
          message: `must differ from ${other}`,
        });
      }
    }
    // The bundle's signing key (ADR 0057): a seed of 32 bytes, shared with
    // nothing; retired public keys parse and never reuse the version.
    if (!decodeSeed(env.GATE_BUNDLE_SIGNING_KEY))
      ctx.addIssue({
        code: 'custom',
        path: ['GATE_BUNDLE_SIGNING_KEY'],
        message: 'must be a 32-byte seed in base64 (`openssl rand -base64 32`)',
      });
    for (const other of [
      'JWT_ACCESS_SECRET',
      'PLATFORM_JWT_SECRET',
      'IDENTIFIER_PEPPER',
      'ENTRY_CREDENTIAL_KEY',
      'PARCEL_TOKEN_KEY',
      'ENGAGEMENT_REF_SECRET',
      'VISITOR_PASS_TOKEN_KEY',
      'PAYMENT_CREDENTIALS_KEY',
    ] as const)
      if (env.GATE_BUNDLE_SIGNING_KEY === env[other])
        ctx.addIssue({
          code: 'custom',
          path: ['GATE_BUNDLE_SIGNING_KEY'],
          message: `must differ from ${other}`,
        });
    if (env.GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS !== undefined) {
      const previous = parsePreviousPublicKeys(
        env.GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS,
      );
      if (!(previous instanceof Map))
        ctx.addIssue({
          code: 'custom',
          path: ['GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS'],
          message: previous.invalid,
        });
      else if (previous.has(env.GATE_BUNDLE_SIGNING_KEY_VERSION))
        ctx.addIssue({
          code: 'custom',
          path: ['GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS'],
          message: 'must not reuse GATE_BUNDLE_SIGNING_KEY_VERSION',
        });
    }
    // The worker card's keys (ADR 0057): a ring that parses, holds the
    // current version, and shares no key with the other secrets.
    const ring = parseEngagementTokenKeys(env.ENGAGEMENT_TOKEN_KEYS);
    if (!(ring instanceof Map)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENGAGEMENT_TOKEN_KEYS'],
        message: ring.invalid,
      });
    } else {
      if (!ring.has(env.ENGAGEMENT_TOKEN_KEY_VERSION))
        ctx.addIssue({
          code: 'custom',
          path: ['ENGAGEMENT_TOKEN_KEY_VERSION'],
          message: 'must name a version of ENGAGEMENT_TOKEN_KEYS',
        });
      for (const other of [
        'JWT_ACCESS_SECRET',
        'PLATFORM_JWT_SECRET',
        'IDENTIFIER_PEPPER',
        'ENTRY_CREDENTIAL_KEY',
        'PARCEL_TOKEN_KEY',
        'ENGAGEMENT_REF_SECRET',
        'VISITOR_PASS_TOKEN_KEY',
        'PAYMENT_CREDENTIALS_KEY',
        'GATE_BUNDLE_SIGNING_KEY',
      ] as const)
        if ([...ring.values()].includes(env[other] ?? ''))
          ctx.addIssue({
            code: 'custom',
            path: ['ENGAGEMENT_TOKEN_KEYS'],
            message: `must not hold ${other}`,
          });
    }
    // The payment vault (ADR 0046): one key of 32 bytes, shared with
    // nothing; retired keys parse and never reuse the current version.
    if (env.PAYMENT_CREDENTIALS_KEY !== undefined) {
      if (!decodePaymentKey(env.PAYMENT_CREDENTIALS_KEY)) {
        ctx.addIssue({
          code: 'custom',
          path: ['PAYMENT_CREDENTIALS_KEY'],
          message:
            'must be base64 of exactly 32 bytes (`openssl rand -base64 32`)',
        });
      }
      for (const other of [
        'JWT_ACCESS_SECRET',
        'PLATFORM_JWT_SECRET',
        'IDENTIFIER_PEPPER',
        'ENTRY_CREDENTIAL_KEY',
        'PARCEL_TOKEN_KEY',
        'ENGAGEMENT_REF_SECRET',
        'VISITOR_PASS_TOKEN_KEY',
      ] as const) {
        if (env.PAYMENT_CREDENTIALS_KEY === env[other]) {
          ctx.addIssue({
            code: 'custom',
            path: ['PAYMENT_CREDENTIALS_KEY'],
            message: `must differ from ${other}`,
          });
        }
      }
    }
    if (env.PAYMENT_CREDENTIALS_PREVIOUS_KEYS !== undefined) {
      const previous = parsePreviousPaymentKeys(
        env.PAYMENT_CREDENTIALS_PREVIOUS_KEYS,
      );
      if ('invalid' in previous) {
        ctx.addIssue({
          code: 'custom',
          path: ['PAYMENT_CREDENTIALS_PREVIOUS_KEYS'],
          message: previous.invalid,
        });
      } else if (
        previous.some((k) => k.version === env.PAYMENT_CREDENTIALS_KEY_VERSION)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['PAYMENT_CREDENTIALS_PREVIOUS_KEYS'],
          message: 'must not reuse PAYMENT_CREDENTIALS_KEY_VERSION',
        });
      }
    }
    // Paymob posts payment results there: never over http in production.
    if (
      env.NODE_ENV === 'production' &&
      env.PAYMENT_WEBHOOK_BASE_URL !== undefined &&
      !env.PAYMENT_WEBHOOK_BASE_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_WEBHOOK_BASE_URL'],
        message: 'must be https:// when NODE_ENV=production',
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
    // Push is all of the service account or none of it. The messages name
    // the variables and never quote a value: one of them is a private key.
    const fcm = {
      FCM_PROJECT_ID: env.FCM_PROJECT_ID,
      FCM_CLIENT_EMAIL: env.FCM_CLIENT_EMAIL,
      FCM_PRIVATE_KEY: env.FCM_PRIVATE_KEY,
    };
    const missing = Object.entries(fcm)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    if (missing.length > 0 && missing.length < 3) {
      for (const name of missing)
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message:
            'FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY must be set together (or none of them, to turn push off)',
        });
    }
    if (
      fcm.FCM_CLIENT_EMAIL !== undefined &&
      fcm.FCM_PRIVATE_KEY !== undefined
    ) {
      const account = fcmServiceAccount(
        fcm.FCM_CLIENT_EMAIL,
        fcm.FCM_PRIVATE_KEY,
      );
      if ('invalid' in account)
        ctx.addIssue({
          code: 'custom',
          path: [account.invalid],
          message:
            account.invalid === 'FCM_CLIENT_EMAIL'
              ? "must be the service account's email address"
              : "must be the service account's private key: a PEM RSA key, its newlines written as \\n",
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
    // A fake vendor answers whatever it is scripted to, and signs its events
    // with a key in the code: never on a server with real residents.
    for (const name of Object.values(VENDOR_DRIVER_VARS))
      if (env.NODE_ENV === 'production' && env[name] === 'fake')
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'must not be fake when NODE_ENV=production',
        });
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
