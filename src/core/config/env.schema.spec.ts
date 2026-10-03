import { validateEnv } from './env.schema';

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
});
