import { generateKeyPairSync } from 'node:crypto';
import { validateEnv } from './env.schema';
import { fcmPrivateKeyPem, fcmServiceAccount } from './fcm-service-account';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://jiwar_app:x@127.0.0.1:5435/jiwar',
  REDIS_URL: 'redis://127.0.0.1:6381',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_FROM: 'Jiwar <no-reply@jiwar.local>',
  S3_BUCKET: 'jiwar',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  IDENTIFIER_PEPPER: 'b'.repeat(32),
  ENTRY_CREDENTIAL_KEY: 'd'.repeat(32),
  PARCEL_TOKEN_KEY: 'e'.repeat(32),
  ENGAGEMENT_REF_SECRET: 'f'.repeat(32),
  VISITOR_PASS_TOKEN_KEY: 'g'.repeat(32),
  ENGAGEMENT_TOKEN_KEYS: `1:${'h'.repeat(32)}`,
  GATE_BUNDLE_SIGNING_KEY: Buffer.alloc(32, 7).toString('base64url'),
  PLATFORM_JWT_SECRET: 'c'.repeat(32),
  PUBLIC_APP_URL: 'https://app.jiwar.test',
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.OTP_FIXED_CODE).toBeUndefined();
  });

  it('defaults object storage to AWS-style URLs and a 5-minute read URL', () => {
    const env = validateEnv(base);
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.S3_URL_TTL_SECONDS).toBe(300);
  });

  it("accepts Cloudflare R2's endpoint and the `auto` region", () => {
    const env = validateEnv({
      ...base,
      S3_ENDPOINT: 'https://0123abcd.r2.cloudflarestorage.com',
      S3_REGION: 'auto',
    });
    expect(env.S3_ENDPOINT).toBe('https://0123abcd.r2.cloudflarestorage.com');
    expect(env.S3_REGION).toBe('auto');
  });

  it('requires a bucket and caps presigned URLs at one hour', () => {
    const { S3_BUCKET: _omit, ...noBucket } = base;
    void _omit;
    expect(() => validateEnv(noBucket)).toThrow(/S3_BUCKET/);
    expect(() => validateEnv({ ...base, S3_URL_TTL_SECONDS: '3601' })).toThrow(
      /S3_URL_TTL_SECONDS/,
    );
  });

  it('rejects OTP_FIXED_CODE when NODE_ENV=production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        OTP_FIXED_CODE: '123456',
      }),
    ).toThrow(/OTP_FIXED_CODE/);
  });

  it('accepts OTP_FIXED_CODE outside production', () => {
    expect(
      validateEnv({ ...base, OTP_FIXED_CODE: '123456' }).OTP_FIXED_CODE,
    ).toBe('123456');
  });

  it('treats an empty OTP_FIXED_CODE as unset, even in production', () => {
    const env = validateEnv({
      ...base,
      NODE_ENV: 'production',
      OTP_FIXED_CODE: '',
    });
    expect(env.OTP_FIXED_CODE).toBeUndefined();
  });

  it.each(['12345', '1234567', 'abcdef'])(
    'rejects a malformed OTP_FIXED_CODE (%s)',
    (code) => {
      expect(() => validateEnv({ ...base, OTP_FIXED_CODE: code })).toThrow(
        /6 digits/,
      );
    },
  );

  it('rejects short secrets', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      validateEnv({ ...base, DATABASE_URL: 'mysql://x@y/z' }),
    ).toThrow(/DATABASE_URL/);
  });

  describe('entry credential key (ADR 0031)', () => {
    it('is required, at least 32 characters', () => {
      const { ENTRY_CREDENTIAL_KEY: _omit, ...without } = base;
      void _omit;
      expect(() => validateEnv(without)).toThrow(/ENTRY_CREDENTIAL_KEY/);
      expect(() =>
        validateEnv({ ...base, ENTRY_CREDENTIAL_KEY: 'short' }),
      ).toThrow(/ENTRY_CREDENTIAL_KEY/);
    });

    it('must differ from the identifier pepper', () => {
      expect(() =>
        validateEnv({ ...base, ENTRY_CREDENTIAL_KEY: base.IDENTIFIER_PEPPER }),
      ).toThrow(
        /must differ from IDENTIFIER_PEPPER[\s\S]*ENTRY_CREDENTIAL_KEY/,
      );
    });
  });

  describe('parcel token key (ADR 0035)', () => {
    it('is required, at least 32 characters', () => {
      const { PARCEL_TOKEN_KEY: _omit, ...without } = base;
      void _omit;
      expect(() => validateEnv(without)).toThrow(/PARCEL_TOKEN_KEY/);
      expect(() => validateEnv({ ...base, PARCEL_TOKEN_KEY: 'short' })).toThrow(
        /PARCEL_TOKEN_KEY/,
      );
    });

    it('must differ from the identifier pepper and from the entry credential key', () => {
      expect(() =>
        validateEnv({ ...base, PARCEL_TOKEN_KEY: base.IDENTIFIER_PEPPER }),
      ).toThrow(/must differ from IDENTIFIER_PEPPER[\s\S]*PARCEL_TOKEN_KEY/);
      expect(() =>
        validateEnv({ ...base, PARCEL_TOKEN_KEY: base.ENTRY_CREDENTIAL_KEY }),
      ).toThrow(/must differ from ENTRY_CREDENTIAL_KEY[\s\S]*PARCEL_TOKEN_KEY/);
    });

    it('limits code checks per guard per minute, 30 by default', () => {
      expect(validateEnv(base).PARCEL_CODE_RATE_LIMIT_PER_MINUTE).toBe(30);
    });
  });

  describe('engagement reference secret (ADR 0040)', () => {
    it('is required, with a message that says how to make one, at least 32 characters', () => {
      const { ENGAGEMENT_REF_SECRET: _omit, ...without } = base;
      void _omit;
      expect(() => validateEnv(without)).toThrow(
        /ENGAGEMENT_REF_SECRET[\s\S]*openssl rand|openssl rand[\s\S]*ENGAGEMENT_REF_SECRET/,
      );
      expect(() =>
        validateEnv({ ...base, ENGAGEMENT_REF_SECRET: 'short' }),
      ).toThrow(/ENGAGEMENT_REF_SECRET/);
    });

    it('must differ from the pepper, the entry credential key and the parcel key', () => {
      for (const other of [
        'IDENTIFIER_PEPPER',
        'ENTRY_CREDENTIAL_KEY',
        'PARCEL_TOKEN_KEY',
      ] as const) {
        expect(() =>
          validateEnv({ ...base, ENGAGEMENT_REF_SECRET: base[other] }),
        ).toThrow(new RegExp(`must differ from ${other}`));
      }
    });
  });

  describe('visitor pass token key (ADR 0043)', () => {
    it('is required, with a message that says how to make one, at least 32 characters', () => {
      const { VISITOR_PASS_TOKEN_KEY: _omit, ...without } = base;
      void _omit;
      expect(() => validateEnv(without)).toThrow(
        /VISITOR_PASS_TOKEN_KEY[\s\S]*openssl rand|openssl rand[\s\S]*VISITOR_PASS_TOKEN_KEY/,
      );
      expect(() =>
        validateEnv({ ...base, VISITOR_PASS_TOKEN_KEY: 'short' }),
      ).toThrow(/VISITOR_PASS_TOKEN_KEY/);
    });

    it('must differ from every other key', () => {
      for (const other of [
        'IDENTIFIER_PEPPER',
        'ENTRY_CREDENTIAL_KEY',
        'PARCEL_TOKEN_KEY',
        'ENGAGEMENT_REF_SECRET',
      ] as const) {
        expect(() =>
          validateEnv({ ...base, VISITOR_PASS_TOKEN_KEY: base[other] }),
        ).toThrow(new RegExp(`must differ from ${other}`));
      }
    });
  });

  describe('the bundle’s signing key (ADR 0057)', () => {
    it('is required: a 32-byte seed, version 1 by default', () => {
      const { GATE_BUNDLE_SIGNING_KEY: _omit, ...without } = base;
      void _omit;
      expect(() => validateEnv(without)).toThrow(/GATE_BUNDLE_SIGNING_KEY/);
      expect(validateEnv(base).GATE_BUNDLE_SIGNING_KEY_VERSION).toBe(1);
      for (const bad of ['short', 'A'.repeat(44), '!'.repeat(43)])
        expect(() =>
          validateEnv({ ...base, GATE_BUNDLE_SIGNING_KEY: bad }),
        ).toThrow(/GATE_BUNDLE_SIGNING_KEY/);
    });

    it('retired public keys parse and never reuse the current version', () => {
      const pub = 'P'.repeat(43);
      expect(
        validateEnv({ ...base, GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS: `2:${pub}` })
          .GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS,
      ).toBe(`2:${pub}`);
      expect(() =>
        validateEnv({ ...base, GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS: `1:${pub}` }),
      ).toThrow(/must not reuse GATE_BUNDLE_SIGNING_KEY_VERSION/);
      expect(() =>
        validateEnv({ ...base, GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS: 'nope' }),
      ).toThrow(/GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS/);
    });

    it('is no other key', () => {
      const seed = Buffer.alloc(32, 9).toString('base64url');
      expect(() =>
        validateEnv({
          ...base,
          GATE_BUNDLE_SIGNING_KEY: seed,
          IDENTIFIER_PEPPER: seed,
        }),
      ).toThrow(/must differ from IDENTIFIER_PEPPER/);
    });
  });

  describe('worker card keys (ADR 0057)', () => {
    it('are required, with a message that says how to make one', () => {
      const { ENGAGEMENT_TOKEN_KEYS: _omit, ...without } = base;
      void _omit;
      expect(() => validateEnv(without)).toThrow(
        /ENGAGEMENT_TOKEN_KEYS[\s\S]*openssl rand|openssl rand[\s\S]*ENGAGEMENT_TOKEN_KEYS/,
      );
    });

    it('a ring of versions, the current one in it, version 1 by default', () => {
      expect(validateEnv(base).ENGAGEMENT_TOKEN_KEY_VERSION).toBe(1);
      const two = `1:${'h'.repeat(32)},2:${'i'.repeat(32)}`;
      expect(
        validateEnv({
          ...base,
          ENGAGEMENT_TOKEN_KEYS: two,
          ENGAGEMENT_TOKEN_KEY_VERSION: '2',
        }).ENGAGEMENT_TOKEN_KEY_VERSION,
      ).toBe(2);
      expect(() =>
        validateEnv({ ...base, ENGAGEMENT_TOKEN_KEY_VERSION: '2' }),
      ).toThrow(/ENGAGEMENT_TOKEN_KEY_VERSION/);
      for (const bad of [
        'h'.repeat(32),
        `1:short`,
        `1:${'h'.repeat(32)},1:${'i'.repeat(32)}`,
        `1:${'h'.repeat(32)},2:${'h'.repeat(32)}`,
      ])
        expect(() =>
          validateEnv({ ...base, ENGAGEMENT_TOKEN_KEYS: bad }),
        ).toThrow(/ENGAGEMENT_TOKEN_KEYS/);
    });

    it('holds no other secret, never quoting one', () => {
      for (const other of [
        'JWT_ACCESS_SECRET',
        'PLATFORM_JWT_SECRET',
        'IDENTIFIER_PEPPER',
        'ENTRY_CREDENTIAL_KEY',
        'PARCEL_TOKEN_KEY',
        'ENGAGEMENT_REF_SECRET',
        'VISITOR_PASS_TOKEN_KEY',
      ] as const) {
        const run = () =>
          validateEnv({
            ...base,
            ENGAGEMENT_TOKEN_KEYS: `1:${'h'.repeat(32)},2:${base[other]}`,
          });
        expect(run).toThrow(new RegExp(`must not hold ${other}`));
        try {
          run();
        } catch (e) {
          expect(String(e)).not.toContain(base[other]);
        }
      }
    });
  });

  describe('platform', () => {
    it('requires a platform secret different from the tenant secret', () => {
      expect(() =>
        validateEnv({ ...base, PLATFORM_JWT_SECRET: base.JWT_ACCESS_SECRET }),
      ).toThrow(/PLATFORM_JWT_SECRET/);
      const { PLATFORM_JWT_SECRET: _omit, ...without } = base;
      void _omit;
      expect(() => validateEnv(without)).toThrow(/PLATFORM_JWT_SECRET/);
    });

    it('accepts no superadmin, or email + password together', () => {
      expect(validateEnv(base).SUPERADMIN_EMAIL).toBeUndefined();
      const env = validateEnv({
        ...base,
        SUPERADMIN_EMAIL: 'owner@jiwar.local',
        SUPERADMIN_PASSWORD: 'correct horse battery',
      });
      expect(env.SUPERADMIN_EMAIL).toBe('owner@jiwar.local');
    });

    it('rejects one without the other', () => {
      expect(() =>
        validateEnv({ ...base, SUPERADMIN_EMAIL: 'owner@jiwar.local' }),
      ).toThrow(/set together/);
      expect(() =>
        validateEnv({ ...base, SUPERADMIN_PASSWORD: 'correct horse battery' }),
      ).toThrow(/set together/);
    });

    describe('FCM (ADR 0041)', () => {
      // A key made for this run, written the way an env line holds it.
      const pem = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey;
      const escaped = pem.replace(/\n/g, '\\n');
      const fcm = {
        FCM_PROJECT_ID: 'jiwar-test',
        FCM_CLIENT_EMAIL: 'push@jiwar-test.iam.gserviceaccount.com',
        FCM_PRIVATE_KEY: escaped,
      };
      const failure = (extra: Record<string, string>): string => {
        try {
          validateEnv({ ...base, ...extra });
        } catch (error) {
          return (error as Error).message;
        }
        return '';
      };

      it('push is off with none of the three; empty means unset', () => {
        const off = validateEnv(base);
        expect(off.FCM_PROJECT_ID).toBeUndefined();
        expect(off.FCM_CLIENT_EMAIL).toBeUndefined();
        expect(off.FCM_PRIVATE_KEY).toBeUndefined();
        const empty = validateEnv({
          ...base,
          FCM_PROJECT_ID: '',
          FCM_CLIENT_EMAIL: '',
          FCM_PRIVATE_KEY: '',
        });
        expect(empty.FCM_PRIVATE_KEY).toBeUndefined();
      });

      it('takes all three, the key with its newlines written as \\n', () => {
        expect(escaped).not.toContain('\n');
        expect(validateEnv({ ...base, ...fcm })).toMatchObject({
          FCM_PROJECT_ID: 'jiwar-test',
          FCM_CLIENT_EMAIL: fcm.FCM_CLIENT_EMAIL,
        });
        // A loader that already expanded the newlines changes nothing.
        expect(() =>
          validateEnv({ ...base, ...fcm, FCM_PRIVATE_KEY: pem }),
        ).not.toThrow();
        expect(fcmPrivateKeyPem(escaped)).toBe(pem);
        expect(fcmPrivateKeyPem(pem)).toBe(pem);
        expect(fcmServiceAccount(fcm.FCM_CLIENT_EMAIL, escaped)).toEqual({
          clientEmail: fcm.FCM_CLIENT_EMAIL,
          privateKey: pem,
        });
      });

      it('refuses only some of the three, naming the missing ones', () => {
        const names = Object.keys(fcm) as (keyof typeof fcm)[];
        for (const set of [
          ['FCM_PROJECT_ID'],
          ['FCM_CLIENT_EMAIL'],
          ['FCM_PRIVATE_KEY'],
          ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL'],
          ['FCM_PROJECT_ID', 'FCM_PRIVATE_KEY'],
          ['FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY'],
        ] as (keyof typeof fcm)[][]) {
          const message = failure(
            Object.fromEntries(set.map((name) => [name, fcm[name]])),
          );
          expect(message).toMatch(/must be set together/);
          for (const name of names) {
            // "→ at NAME": the issue's path, which the missing ones get.
            expect([set, name, message.includes(`at ${name}`)]).toEqual([
              set,
              name,
              !set.includes(name),
            ]);
          }
          expect(message).not.toContain(escaped);
          expect(message).not.toContain('MII');
        }
      });

      it('refuses an email that is not one and a key that is not a private RSA key, without quoting them', () => {
        const email = failure({ ...fcm, FCM_CLIENT_EMAIL: 'not-an-email' });
        expect(email).toMatch(/at FCM_CLIENT_EMAIL/);
        expect(email).not.toContain('not-an-email');
        expect(email).not.toContain(escaped);

        const ec = generateKeyPairSync('ec', {
          namedCurve: 'P-256',
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        }).privateKey.replace(/\n/g, '\\n');
        const publicOnly = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        }).publicKey.replace(/\n/g, '\\n');
        for (const value of [
          'secret-key-material',
          '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n',
          escaped.slice(0, 200),
          ec,
          publicOnly,
        ]) {
          const message = failure({ ...fcm, FCM_PRIVATE_KEY: value });
          expect(message).toMatch(/at FCM_PRIVATE_KEY/);
          expect(message).not.toContain(value);
          expect(message).not.toContain(value.slice(0, 40));
        }
      });
    });

    it('rejects a superadmin password shorter than 12 characters', () => {
      expect(() =>
        validateEnv({
          ...base,
          SUPERADMIN_EMAIL: 'owner@jiwar.local',
          SUPERADMIN_PASSWORD: 'short-pass',
        }),
      ).toThrow(/at least 12/);
    });
  });

  describe('TRUST_PROXY', () => {
    it('defaults to off', () => {
      expect(validateEnv(base).TRUST_PROXY).toBe(false);
    });

    it.each([
      ['false', false],
      ['0', false],
      ['1', 1],
      ['2', 2],
    ])('%s → %p', (raw, parsed) => {
      expect(validateEnv({ ...base, TRUST_PROXY: raw }).TRUST_PROXY).toBe(
        parsed,
      );
    });

    it.each(['true', 'yes', '-1', '127.0.0.1'])('rejects %s', (raw) => {
      expect(() => validateEnv({ ...base, TRUST_PROXY: raw })).toThrow(
        /TRUST_PROXY/,
      );
    });
  });

  describe('PUBLIC_APP_URL (ADR 0030)', () => {
    it('is required', () => {
      expect(() => validateEnv({ ...base, PUBLIC_APP_URL: undefined })).toThrow(
        /PUBLIC_APP_URL/,
      );
    });

    it('drops a trailing slash', () => {
      expect(
        validateEnv({ ...base, PUBLIC_APP_URL: 'https://app.jiwar.eg/' })
          .PUBLIC_APP_URL,
      ).toBe('https://app.jiwar.eg');
    });

    it.each([
      'app.jiwar.eg',
      'ftp://app.jiwar.eg',
      'https://a b',
      'https://x?y',
    ])('rejects %s', (raw) => {
      expect(() => validateEnv({ ...base, PUBLIC_APP_URL: raw })).toThrow(
        /PUBLIC_APP_URL/,
      );
    });

    it('must be https in production', () => {
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          PUBLIC_APP_URL: 'http://app.jiwar.eg',
        }),
      ).toThrow(/PUBLIC_APP_URL/);
      expect(
        validateEnv({ ...base, PUBLIC_APP_URL: 'http://localhost:5173' })
          .PUBLIC_APP_URL,
      ).toBe('http://localhost:5173');
      expect(
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          PUBLIC_APP_URL: 'https://app.jiwar.eg',
        }).PUBLIC_APP_URL,
      ).toBe('https://app.jiwar.eg');
    });
  });

  describe('payment settings (ADR 0046)', () => {
    const key = Buffer.alloc(32, 7).toString('base64');

    it('all optional, with defaults', () => {
      const env = validateEnv(base);
      expect(env.PAYMENT_CREDENTIALS_KEY).toBeUndefined();
      expect(env.PAYMENT_CREDENTIALS_KEY_VERSION).toBe(1);
      expect(env.PAYMENT_WEBHOOK_BASE_URL).toBeUndefined();
      expect(env.PAYMOB_BASE_URL).toBe('https://accept.paymob.com');
      expect(env.PAYMOB_REQUEST_TIMEOUT_MS).toBe(15000);
      expect(env.PAYMENT_SESSION_TTL_MINUTES).toBe(30);
    });

    it('the key is base64 of exactly 32 bytes, and shared with no other secret', () => {
      expect(
        validateEnv({ ...base, PAYMENT_CREDENTIALS_KEY: key })
          .PAYMENT_CREDENTIALS_KEY,
      ).toBe(key);
      expect(() =>
        validateEnv({ ...base, PAYMENT_CREDENTIALS_KEY: 'a'.repeat(32) }),
      ).toThrow(/32 bytes[\s\S]*PAYMENT_CREDENTIALS_KEY/);
      const shared = Buffer.alloc(32, 9).toString('base64');
      expect(() =>
        validateEnv({
          ...base,
          IDENTIFIER_PEPPER: shared,
          PAYMENT_CREDENTIALS_KEY: shared,
        }),
      ).toThrow(/must differ from IDENTIFIER_PEPPER/);
    });

    it('retired keys parse and never reuse the current version', () => {
      expect(() =>
        validateEnv({
          ...base,
          PAYMENT_CREDENTIALS_KEY: key,
          PAYMENT_CREDENTIALS_PREVIOUS_KEYS: `1:${key}`,
        }),
      ).toThrow(/must not reuse PAYMENT_CREDENTIALS_KEY_VERSION/);
      expect(() =>
        validateEnv({ ...base, PAYMENT_CREDENTIALS_PREVIOUS_KEYS: 'nonsense' }),
      ).toThrow(/PAYMENT_CREDENTIALS_PREVIOUS_KEYS/);
      expect(
        validateEnv({
          ...base,
          PAYMENT_CREDENTIALS_KEY: key,
          PAYMENT_CREDENTIALS_KEY_VERSION: '2',
          PAYMENT_CREDENTIALS_PREVIOUS_KEYS: `1:${key}`,
        }).PAYMENT_CREDENTIALS_KEY_VERSION,
      ).toBe(2);
    });

    it('the webhook base is an origin, https in production', () => {
      expect(
        validateEnv({ ...base, PAYMENT_WEBHOOK_BASE_URL: 'https://x.test/' })
          .PAYMENT_WEBHOOK_BASE_URL,
      ).toBe('https://x.test');
      expect(() =>
        validateEnv({
          ...base,
          PAYMENT_WEBHOOK_BASE_URL: 'https://x.test/api',
        }),
      ).toThrow(/without a path/);
      expect(() =>
        validateEnv({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_WEBHOOK_BASE_URL: 'http://x.test',
        }),
      ).toThrow(/https[\s\S]*PAYMENT_WEBHOOK_BASE_URL/);
    });

    it('timeouts and lifetimes stay within their ranges', () => {
      expect(() =>
        validateEnv({ ...base, PAYMOB_REQUEST_TIMEOUT_MS: '500' }),
      ).toThrow();
      expect(() =>
        validateEnv({ ...base, PAYMENT_SESSION_TTL_MINUTES: '5' }),
      ).toThrow();
    });
  });
});

describe('guard vendor drivers (ADR 0068)', () => {
  const vars = [
    'GATE_FACE_DRIVER',
    'GATE_ID_SCAN_DRIVER',
    'GATE_CALL_DRIVER',
    'GATE_ALARM_DRIVER',
    'CONTROL_ROOM_DRIVER',
  ] as const;

  it('unset, empty or chosen: fake and off, a 5 s timeout by default', () => {
    const env = validateEnv(base);
    for (const name of vars) expect(env[name]).toBeUndefined();
    expect(env.GATE_VENDOR_TIMEOUT_MS).toBe(5000);
    for (const name of vars) {
      expect(validateEnv({ ...base, [name]: '' })[name]).toBeUndefined();
      expect(validateEnv({ ...base, [name]: 'fake' })[name]).toBe('fake');
      expect(validateEnv({ ...base, [name]: 'off' })[name]).toBe('off');
    }
  });

  it.each(vars)('%s: a fake is refused in production, off is not', (name) => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', [name]: 'fake' }),
    ).toThrow(new RegExp(`must not be fake[\\s\\S]*${name}`));
    expect(
      validateEnv({ ...base, NODE_ENV: 'production', [name]: 'off' })[name],
    ).toBe('off');
  });

  it.each(vars)('%s: nothing but fake or off', (name) => {
    expect(() => validateEnv({ ...base, [name]: 'acme' })).toThrow(
      new RegExp(name),
    );
  });

  it('the timeout stays between half a second and 30 s', () => {
    expect(() =>
      validateEnv({ ...base, GATE_VENDOR_TIMEOUT_MS: '100' }),
    ).toThrow(/GATE_VENDOR_TIMEOUT_MS/);
    expect(() =>
      validateEnv({ ...base, GATE_VENDOR_TIMEOUT_MS: '60000' }),
    ).toThrow(/GATE_VENDOR_TIMEOUT_MS/);
  });
});
