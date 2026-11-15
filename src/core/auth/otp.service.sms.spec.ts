import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { GlobalDbService } from '../database/global-db.service';
import type { TenantTx } from '../database/tenant-tx.service';
import type { SecurityEventsService } from '../audit/security-events.service';
import type { RateLimitService } from '../redis/rate-limit.service';
import type { SmsSender } from '../sms/sms-sender';
import { IdentifierHasher } from './identifier';
import type { OtpChannel, OtpMessage } from './otp-channel';
import { OtpService } from './otp.service';
import { SmsLoginPolicy } from './sms-login.policy';
import { SmsDeliveryError } from './sms-otp.channel';

/**
 * The channel choice of a login code (ADR 0095): who gets a text, who an
 * email, what a failure or a cap does. The database is a fake that keeps
 * what the service wrote; the real thing is in test/auth/sms-login.
 */

const PHONE = '+201012345678';
const HASH = 'identifier-hash';

interface Challenge {
  id: string;
  accountIds: string[];
  invalidatedAt?: Date;
}

const settings: Partial<Record<keyof Env, unknown>> = {
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 5,
  IDENTIFIER_PEPPER: 'p'.repeat(32),
  SMS_ALLOWED_COUNTRY_CODES: ['+20'],
  SMS_MAX_PER_PHONE_PER_DAY: 10,
  SMS_MAX_PER_HOUR: 300,
};

function setup(
  opts: {
    accounts?: { id: string; tenantId: string; email: string | null }[];
    sms?: 'on' | 'off';
    smsFails?: SmsDeliveryError | Error;
    perPhone?: number;
  } = {},
) {
  const accounts = opts.accounts ?? [
    { id: 'a1', tenantId: 't1', email: 'one@example.test' },
  ];
  const config = {
    get: (key: keyof Env) =>
      key === 'SMS_MAX_PER_PHONE_PER_DAY' && opts.perPhone
        ? opts.perPhone
        : settings[key],
  } as unknown as ConfigService<Env, true>;

  const challenges: Challenge[] = [];
  const globalDb = {
    loginIdentifier: {
      findMany: jest.fn(() =>
        Promise.resolve(
          accounts.map((a) => ({ accountId: a.id, tenantId: a.tenantId })),
        ),
      ),
    },
    otpChallenge: {
      create: jest.fn(({ data }: { data: Challenge }) => {
        challenges.push({ id: data.id, accountIds: data.accountIds });
        return Promise.resolve(data);
      }),
      createMany: jest.fn(({ data }: { data: Challenge[] }) => {
        for (const c of data)
          challenges.push({ id: c.id, accountIds: c.accountIds });
        return Promise.resolve({ count: data.length });
      }),
      updateMany: jest.fn(
        ({
          where,
        }: {
          where: { id: string | { lt: string; not?: string } };
        }) => {
          let count = 0;
          for (const c of challenges) {
            const hit =
              typeof where.id === 'string'
                ? c.id === where.id
                : c.id < where.id.lt && c.id !== where.id.not;
            if (hit && !c.invalidatedAt) {
              c.invalidatedAt = new Date();
              count++;
            }
          }
          return Promise.resolve({ count });
        },
      ),
    },
  } as unknown as GlobalDbService;
  const tenantTx = {
    runInTenantUnsafe: (
      _tenantId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      fn({
        account: {
          findUnique: ({ where }: { where: { id: string } }) =>
            Promise.resolve({
              email: accounts.find((a) => a.id === where.id)?.email ?? null,
              status: 'active',
            }),
        },
      }),
  } as unknown as TenantTx;

  const emails: OtpMessage[] = [];
  const texts: OtpMessage[] = [];
  const emailChannel: OtpChannel = {
    send: (m) => {
      emails.push(m);
      return Promise.resolve();
    },
  };
  const smsChannel: OtpChannel = {
    send: (m) => {
      texts.push(m);
      return opts.smsFails ? Promise.reject(opts.smsFails) : Promise.resolve();
    },
  };

  const counts = new Map<string, number>();
  const rateLimit = {
    hit: (key: string) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return Promise.resolve(n);
    },
  } as unknown as RateLimitService;
  const sender: SmsSender | null =
    opts.sms === 'off'
      ? null
      : { provider: 'log', send: () => Promise.resolve({ ok: true }) };
  const events: { event: string; metadata?: Record<string, unknown> }[] = [];
  const securityEvents = {
    recordInBackground: (event: string, data: { metadata?: object }) => {
      events.push({
        event,
        metadata: data.metadata as Record<string, unknown>,
      });
    },
  } as unknown as SecurityEventsService;

  const service = new OtpService(
    config,
    globalDb,
    tenantTx,
    new IdentifierHasher(config),
    emailChannel,
    smsChannel,
    new SmsLoginPolicy(config, sender, rateLimit),
    securityEvents,
  );
  return { service, emails, texts, events, challenges, counts };
}

const names = (events: { event: string }[]) => events.map((e) => e.event);

describe('OtpService.issue: the channel of a login code', () => {
  let logged: string[];
  beforeEach(() => {
    logged = [];
    for (const method of ['log', 'warn', 'error', 'debug'] as const)
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        });
  });
  afterEach(() => jest.restoreAllMocks());

  it('an email login goes by email only, as before', async () => {
    const t = setup();
    await t.service.issue(HASH, 'en', null);
    expect(t.texts).toEqual([]);
    expect(t.emails).toHaveLength(1);
    expect(t.emails[0]).toMatchObject({ to: 'one@example.test' });
    expect(t.events).toEqual([
      { event: 'otp.requested', metadata: { locale: 'en', destinations: 1 } },
    ]);
  });

  it('a phone login goes by SMS to that phone, and by no email', async () => {
    const t = setup();
    await t.service.issue(HASH, 'ar', PHONE);
    expect(t.emails).toEqual([]);
    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toMatchObject({
      to: PHONE,
      locale: 'ar',
      purpose: 'login',
      ttlSeconds: 300,
    });
    expect(names(t.events)).toEqual(['otp.requested', 'otp.sms_sent']);
    expect(t.events[0].metadata).toEqual({
      locale: 'ar',
      destinations: 1,
      channel: 'sms',
    });
  });

  it('one challenge unlocks every account behind the phone, whatever its email', async () => {
    const t = setup({
      accounts: [
        { id: 'a1', tenantId: 't1', email: 'one@example.test' },
        { id: 'a2', tenantId: 't2', email: 'two@example.test' },
        { id: 'a3', tenantId: 't3', email: null },
      ],
    });
    await t.service.issue(HASH, 'en', PHONE);
    expect(t.texts).toHaveLength(1);
    expect(t.challenges).toHaveLength(1);
    expect(t.challenges[0].accountIds).toEqual(['a1', 'a2', 'a3']);
  });

  it('an unknown phone gets no text and no email', async () => {
    const t = setup({ accounts: [] });
    await t.service.issue(HASH, 'en', PHONE);
    expect(t.texts).toEqual([]);
    expect(t.emails).toEqual([]);
    expect(t.challenges).toEqual([]);
    expect(t.counts.size).toBe(0);
    expect(t.events).toEqual([
      { event: 'otp.requested', metadata: { locale: 'en', destinations: 0 } },
    ]);
  });

  it('a phone outside the allowed countries goes by email, as if SMS were off', async () => {
    const t = setup();
    await t.service.issue(HASH, 'en', '+971501234567');
    expect(t.texts).toEqual([]);
    expect(t.emails).toHaveLength(1);
    expect(names(t.events)).toEqual(['otp.requested']);
    expect(t.counts.size).toBe(0);
  });

  it('with SMS off, a phone login goes by email', async () => {
    const t = setup({ sms: 'off' });
    await t.service.issue(HASH, 'en', PHONE);
    expect(t.texts).toEqual([]);
    expect(t.emails).toHaveLength(1);
    expect(names(t.events)).toEqual(['otp.requested']);
  });

  it('a refused text falls back to the emails, each account behind its own', async () => {
    const t = setup({
      accounts: [
        { id: 'a1', tenantId: 't1', email: 'one@example.test' },
        { id: 'a2', tenantId: 't2', email: 'two@example.test' },
      ],
      smsFails: new SmsDeliveryError('number', 'TWILIO_21211'),
    });
    await t.service.issue(HASH, 'en', PHONE);
    expect(t.texts).toHaveLength(1);
    expect(t.emails.map((m) => m.to).sort()).toEqual([
      'one@example.test',
      'two@example.test',
    ]);
    expect(names(t.events)).toEqual(['otp.sms_failed', 'otp.requested']);
    expect(t.events[0].metadata).toEqual({
      locale: 'en',
      reason: 'number',
      code: 'TWILIO_21211',
      fallback: 'email',
    });
    // The text's challenge is dead; only the two emailed ones are live.
    const live = t.challenges.filter((c) => !c.invalidatedAt);
    expect(live.map((c) => c.accountIds).sort()).toEqual([['a1'], ['a2']]);
  });

  it('a text that timed out may still arrive: its code stays live beside the emailed one', async () => {
    const t = setup({ smsFails: new SmsDeliveryError('unknown', 'TIMEOUT') });
    await t.service.issue(HASH, 'en', PHONE);
    expect(t.emails).toHaveLength(1);
    const live = t.challenges.filter((c) => !c.invalidatedAt);
    expect(live).toHaveLength(2);
  });

  it('a failure with nobody to email is recorded as such', async () => {
    const t = setup({
      accounts: [{ id: 'a1', tenantId: 't1', email: null }],
      smsFails: new SmsDeliveryError('rejected', 'TWILIO_20003'),
    });
    await t.service.issue(HASH, 'en', PHONE);
    expect(t.emails).toEqual([]);
    expect(t.events[0]).toMatchObject({
      event: 'otp.sms_failed',
      metadata: { fallback: 'none' },
    });
  });

  it('an error that is not the sender’s is a failure too, never an exception', async () => {
    const t = setup({ smsFails: new Error('boom') });
    await expect(t.service.issue(HASH, 'en', PHONE)).resolves.toBeUndefined();
    expect(t.emails).toHaveLength(1);
    expect(t.events[0].metadata).toMatchObject({ reason: 'unknown' });
  });

  it('past the number’s daily cap the code goes by email and the cap is recorded', async () => {
    const t = setup({ perPhone: 2 });
    await t.service.issue(HASH, 'en', PHONE);
    await t.service.issue(HASH, 'en', PHONE);
    t.events.length = 0;
    await t.service.issue(HASH, 'en', PHONE);
    expect(t.texts).toHaveLength(2);
    expect(t.emails).toHaveLength(1);
    expect(names(t.events)).toEqual(['otp.sms_capped', 'otp.requested']);
    expect(t.events[0].metadata).toEqual({ locale: 'en', cap: 'phone_daily' });
  });

  it('a request leaves exactly its own newest code live', async () => {
    const t = setup();
    await t.service.issue(HASH, 'en', PHONE);
    await t.service.issue(HASH, 'en', PHONE);
    expect(t.challenges.filter((c) => !c.invalidatedAt)).toHaveLength(1);
  });

  it('never puts the number in an event or a log line', async () => {
    const t = setup({
      smsFails: new SmsDeliveryError('number', 'TWILIO_21211'),
    });
    await t.service.issue(HASH, 'en', PHONE);
    const everything = JSON.stringify([t.events, logged]);
    expect(everything).not.toContain(PHONE);
    expect(everything).not.toContain('1012345678');
    expect(logged.some((l) => l.includes('falling back to email'))).toBe(true);
  });
});
