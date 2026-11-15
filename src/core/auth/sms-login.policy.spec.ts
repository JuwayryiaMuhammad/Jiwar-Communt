import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { RateLimitService } from '../redis/rate-limit.service';
import type { SmsSender } from '../sms/sms-sender';
import { SmsLoginPolicy } from './sms-login.policy';

const sender: SmsSender = {
  provider: 'log',
  send: () => Promise.resolve({ ok: true }),
};

/** Counters in a map, one fixed window each, like Redis. */
class FakeRateLimit {
  readonly counts = new Map<string, number>();
  readonly windows = new Map<string, number>();
  hit(key: string, windowSeconds: number): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    this.windows.set(key, windowSeconds);
    return Promise.resolve(next);
  }
}

function policy(
  opts: {
    sender?: SmsSender | null;
    countries?: string[];
    perPhone?: number;
    perHour?: number;
  } = {},
) {
  const limits = new FakeRateLimit();
  const values: Partial<Record<keyof Env, unknown>> = {
    SMS_ALLOWED_COUNTRY_CODES: opts.countries ?? ['+20'],
    SMS_MAX_PER_PHONE_PER_DAY: opts.perPhone ?? 10,
    SMS_MAX_PER_HOUR: opts.perHour ?? 300,
  };
  const config = {
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>;
  return {
    limits,
    policy: new SmsLoginPolicy(
      config,
      opts.sender === undefined ? sender : opts.sender,
      limits as unknown as RateLimitService,
    ),
  };
}

describe('SmsLoginPolicy.available', () => {
  it('is yes for an Egyptian number by default', () => {
    expect(policy().policy.available('+201012345678')).toBe(true);
  });

  it('is no for a number outside the allowed countries', () => {
    expect(policy().policy.available('+971501234567')).toBe(false);
    expect(policy().policy.available('+447400123456')).toBe(false);
  });

  it('follows the list from the environment', () => {
    const p = policy({ countries: ['+20', '+966'] }).policy;
    expect(p.available('+201012345678')).toBe(true);
    expect(p.available('+966501234567')).toBe(true);
    expect(p.available('+971501234567')).toBe(false);
  });

  it('is no when SMS is off, whatever the country', () => {
    expect(policy({ sender: null }).policy.available('+201012345678')).toBe(
      false,
    );
  });

  it('is no for something that is not a number', () => {
    expect(policy().policy.available('nonsense')).toBe(false);
  });
});

describe('SmsLoginPolicy.admit', () => {
  it('admits a number up to its daily cap and then holds it back', async () => {
    const { policy: p, limits } = policy({ perPhone: 3 });
    for (let i = 0; i < 3; i++) await expect(p.admit('h1')).resolves.toBeNull();
    await expect(p.admit('h1')).resolves.toBe('phone_daily');
    // Another number is not affected.
    await expect(p.admit('h2')).resolves.toBeNull();
    expect(limits.windows.get('sms:phone:h1')).toBe(86_400);
  });

  it('holds everything back past the service hourly cap', async () => {
    const { policy: p, limits } = policy({ perHour: 2 });
    await expect(p.admit('a')).resolves.toBeNull();
    await expect(p.admit('b')).resolves.toBeNull();
    await expect(p.admit('c')).resolves.toBe('global_hourly');
    expect(limits.windows.get('sms:global')).toBe(3_600);
  });

  it("a number past its own cap does not spend the service's budget", async () => {
    const { policy: p, limits } = policy({ perPhone: 1, perHour: 100 });
    await p.admit('a');
    await p.admit('a');
    await p.admit('a');
    expect(limits.counts.get('sms:global')).toBe(1);
  });

  it('keys by the identifier hash, never by the number', async () => {
    const { policy: p, limits } = policy();
    await p.admit('hash-of-the-number');
    expect([...limits.counts.keys()].sort()).toEqual([
      'sms:global',
      'sms:phone:hash-of-the-number',
    ]);
  });
});
