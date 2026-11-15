import '../setup/sms-env';
import type Redis from 'ioredis';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { REDIS } from '../../src/core/redis/redis.token';
import { SMS_LOGIN_COVERAGE } from '../setup/audit-coverage-split';
import { auditReaders } from '../setup/audit';
import { uniqueUkDigits } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { countEmails, waitForOtp } from '../setup/mailpit';
import { countSms, smsLog, waitForSms } from '../setup/sms';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';

interface Verified {
  loginTicket: string;
  accounts: { accountId: string; tenantName: string; accountType: string }[];
}

/**
 * Login codes by SMS (ADR 0095), with SMS_PROVIDER=log: a login typed as a
 * phone goes by text to that phone, an email login by email, a phone
 * outside Egypt by email, a text that cannot go falls back to email, an
 * unknown phone gets nothing and the same answer, the caps hold, and a
 * code only ever unlocks the accounts behind what it was sent to.
 */
describe('Login codes by SMS', () => {
  let h: HttpHarness;
  let read: ReturnType<typeof auditReaders>;
  let redis: Redis;
  const covered = new Set<string>();

  beforeAll(async () => {
    expect(process.env.SMS_PROVIDER).toBe('log');
    expect(process.env.OTP_FIXED_CODE).toBeUndefined();
    h = await createHttpHarness();
    read = auditReaders(h);
    redis = h.moduleRef.get<Redis>(REDIS);
  });

  afterAll(() => h.close());

  const hashOf = (type: 'email' | 'phone', value: string) =>
    h.moduleRef.get(IdentifierHasher).hashIdentifier({ type, value });

  async function event(name: string, identifierHash: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await read.security({ event: name, identifierHash });
      if (rows.length || Date.now() > deadline) {
        if (rows.length && SMS_LOGIN_COVERAGE.includes(name)) covered.add(name);
        return rows;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function request(identifier: string, language?: string) {
    const req = h.http().post(`${API}/auth/otp/request`);
    if (language) void req.set('Accept-Language', language);
    return req.send({ identifier }).expect(202);
  }

  async function verify(identifier: string, code: string, status = 200) {
    const res = await h
      .http()
      .post(`${API}/auth/otp/verify`)
      .send({ identifier, code })
      .expect(status);
    return res.body as Verified;
  }

  async function resident(
    tenantId: string,
    over: { email?: string; phone?: string } = {},
  ) {
    const email = over.email ?? uniqueEmail('sms');
    const phone = over.phone ?? uniquePhone();
    const account = await h.createAccount(tenantId, {
      type: 'resident',
      email,
      phone,
    });
    return { id: account.id, email, phone };
  }

  it('a phone login gets its code by SMS, to that phone, and logs in', async () => {
    const t = await h.createTenant('Compound SMS');
    const r = await resident(t.id);
    const since = new Date();

    // Typed in the local format: the text goes to the normalized number.
    const local = `0${r.phone.slice(3)}`;
    const res = await request(local);
    expect(res.body).toMatchObject({ code: 'OTP_REQUESTED' });
    const sms = await waitForSms(h, r.phone, since);
    expect(await countEmails(r.email, since, 500)).toBe(0);

    // Arabic when the client sends nothing, like the email; short; no link.
    expect(sms.body).toContain('جوار');
    expect(sms.body).toContain(sms.code);
    expect(sms.body.length).toBeLessThanOrEqual(70);

    const verified = await verify(local, sms.code);
    expect(verified.accounts.map((a) => a.accountId)).toEqual([r.id]);
    await h
      .http()
      .post(`${API}/auth/select-account`)
      .send({ loginTicket: verified.loginTicket, accountId: r.id })
      .expect(200);

    const hash = hashOf('phone', r.phone);
    const requested = await event('otp.requested', hash);
    expect(requested[0].metadata).toEqual({
      locale: 'ar',
      destinations: 1,
      channel: 'sms',
    });
    const sent = await event('otp.sms_sent', hash);
    expect(sent).toHaveLength(1);
    expect(
      await read.security({ event: 'otp.sms_failed', identifierHash: hash }),
    ).toEqual([]);
  });

  it('the text is in English when the client asks for it', async () => {
    const t = await h.createTenant('Compound SMS en');
    const r = await resident(t.id);
    const since = new Date();
    await request(r.phone, 'en');
    const sms = await waitForSms(h, r.phone, since);
    expect(sms.body).toContain('Jiwar');
    expect(sms.body).toContain('login code');
    expect(sms.body).toContain(sms.code);
  });

  it('an email login still goes by email, and no text goes out', async () => {
    const t = await h.createTenant('Compound mail');
    const r = await resident(t.id);
    const since = new Date();
    await request(r.email);
    const code = await waitForOtp(r.email, since);
    expect(await countSms(h, r.phone, since, 500)).toBe(0);
    expect((await verify(r.email, code)).accounts).toHaveLength(1);
    const hash = hashOf('email', r.email);
    expect(
      await read.security({ event: 'otp.sms_sent', identifierHash: hash }),
    ).toEqual([]);
  });

  it('a phone outside Egypt goes by email, as if SMS were off', async () => {
    const t = await h.createTenant('Compound abroad');
    const phone = `+447400${uniqueUkDigits()}`;
    const r = await resident(t.id, { phone });
    const since = new Date();
    await request(phone);
    const code = await waitForOtp(r.email, since);
    expect(await countSms(h, phone, since, 500)).toBe(0);
    expect((await verify(phone, code)).accounts).toHaveLength(1);
    // Nothing about SMS is recorded: it was never an option.
    const hash = hashOf('phone', phone);
    await event('otp.requested', hash);
    for (const name of ['otp.sms_sent', 'otp.sms_failed', 'otp.sms_capped'])
      expect(
        await read.security({ event: name, identifierHash: hash }),
      ).toEqual([]);
  });

  it('a text that cannot go falls back to the email, and the answer never shows it', async () => {
    const t = await h.createTenant('Compound fallback');
    const r = await resident(t.id);
    const unknown = await request(uniquePhone());
    const send = jest.spyOn(smsLog(h), 'send').mockResolvedValueOnce({
      ok: false,
      kind: 'rejected',
      code: 'TWILIO_21408',
    });
    try {
      const since = new Date();
      const res = await request(r.phone);
      expect(res.text).toBe(unknown.text);
      const code = await waitForOtp(r.email, since);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await countSms(h, r.phone, since, 300)).toBe(0);
      // The emailed code works for the phone login, as before ADR 0095.
      expect((await verify(r.phone, code)).accounts).toHaveLength(1);

      const hash = hashOf('phone', r.phone);
      const failed = await event('otp.sms_failed', hash);
      expect(failed).toHaveLength(1);
      expect(failed[0].metadata).toEqual({
        locale: 'ar',
        reason: 'rejected',
        code: 'TWILIO_21408',
        fallback: 'email',
      });
      expect(
        await read.security({ event: 'otp.sms_sent', identifierHash: hash }),
      ).toEqual([]);
    } finally {
      send.mockRestore();
    }
  });

  it('a sender that throws is a failure too', async () => {
    const t = await h.createTenant('Compound throw');
    const r = await resident(t.id);
    const send = jest
      .spyOn(smsLog(h), 'send')
      .mockRejectedValueOnce(new Error('socket hang up'));
    try {
      const since = new Date();
      await request(r.phone);
      const code = await waitForOtp(r.email, since);
      expect((await verify(r.phone, code)).accounts).toHaveLength(1);
    } finally {
      send.mockRestore();
    }
  });

  it('an unknown phone gets the identical answer, no text and no email', async () => {
    const t = await h.createTenant('Compound known');
    const r = await resident(t.id);
    const stranger = uniquePhone();
    const since = new Date();
    const known = await request(r.phone);
    const nobody = await request(stranger);
    const neither = await request(uniqueEmail('nobody'));
    for (const other of [nobody, neither]) {
      expect(other.status).toBe(known.status);
      expect(other.text).toBe(known.text);
    }
    await waitForSms(h, r.phone, since);
    expect(await countSms(h, stranger, since, 500)).toBe(0);
    expect(
      smsLog(h)
        .messages()
        .filter((m) => m.at >= since && m.to === stranger),
    ).toEqual([]);

    const hash = hashOf('phone', stranger);
    const requested = await event('otp.requested', hash);
    expect(requested[0].metadata).toEqual({ locale: 'ar', destinations: 0 });
    for (const name of ['otp.sms_sent', 'otp.sms_failed', 'otp.sms_capped'])
      expect(
        await read.security({ event: name, identifierHash: hash }),
      ).toEqual([]);
  });

  describe('the caps', () => {
    it('a number past its daily cap gets the code by email, and the cap is recorded', async () => {
      const t = await h.createTenant('Compound cap');
      const r = await resident(t.id);
      const hash = hashOf('phone', r.phone);
      // The cap is 10 a day and a number may ask only 5 times in 15 minutes:
      // put the counter at the cap, the way ten earlier days' requests would.
      await redis.set(`rl:sms:phone:${hash}`, '10', 'EX', 86_400);

      const since = new Date();
      await request(r.phone);
      const code = await waitForOtp(r.email, since);
      expect(await countSms(h, r.phone, since, 300)).toBe(0);
      expect((await verify(r.phone, code)).accounts).toHaveLength(1);

      const capped = await event('otp.sms_capped', hash);
      expect(capped).toHaveLength(1);
      expect(capped[0].metadata).toEqual({ locale: 'ar', cap: 'phone_daily' });
    });

    it('past the hourly cap of the whole service, every number gets email', async () => {
      const t = await h.createTenant('Compound global cap');
      const r = await resident(t.id);
      await redis.set('rl:sms:global', '300', 'EX', 3600);
      try {
        const since = new Date();
        await request(r.phone);
        const code = await waitForOtp(r.email, since);
        expect(await countSms(h, r.phone, since, 300)).toBe(0);
        expect((await verify(r.phone, code)).accounts).toHaveLength(1);
        const capped = await event('otp.sms_capped', hashOf('phone', r.phone));
        expect(capped[0].metadata).toEqual({
          locale: 'ar',
          cap: 'global_hourly',
        });
      } finally {
        await redis.del('rl:sms:global');
      }
    });

    it('under the caps every request is counted, for the number and the service', async () => {
      const t = await h.createTenant('Compound counted');
      const r = await resident(t.id);
      const hash = hashOf('phone', r.phone);
      await redis.del('rl:sms:global');
      const since = new Date();
      await request(r.phone);
      await waitForSms(h, r.phone, since);
      expect(await redis.get(`rl:sms:phone:${hash}`)).toBe('1');
      expect(Number(await redis.get('rl:sms:global'))).toBeGreaterThanOrEqual(
        1,
      );
      // A day and an hour, never forever.
      expect(await redis.ttl(`rl:sms:phone:${hash}`)).toBeGreaterThan(3600);
      expect(await redis.ttl('rl:sms:global')).toBeLessThanOrEqual(3600);
    });
  });

  describe('what a code unlocks', () => {
    it("a phone's code never unlocks an account reached only through an email, nor the reverse", async () => {
      const a = await h.createTenant('Compound A');
      const b = await h.createTenant('Compound B');
      const shared = uniqueEmail('shared');
      // The same person's two accounts share an email but not a phone.
      const inA = await resident(a.id, { email: shared });
      const inB = await resident(b.id, { email: shared });

      // By email: one code, both accounts.
      let since = new Date();
      await request(shared);
      const emailCode = await waitForOtp(shared, since);
      expect(
        (await verify(shared, emailCode)).accounts
          .map((x) => x.accountId)
          .sort(),
      ).toEqual([inA.id, inB.id].sort());

      // By A's phone: A only, even though B has the same email.
      since = new Date();
      await request(inA.phone);
      const sms = await waitForSms(h, inA.phone, since);
      const viaPhone = await verify(inA.phone, sms.code);
      expect(viaPhone.accounts.map((x) => x.accountId)).toEqual([inA.id]);

      // The phone's code is no good for the email login, and the reverse.
      since = new Date();
      await request(inA.phone);
      const smsAgain = await waitForSms(h, inA.phone, since);
      await verify(shared, smsAgain.code, 401);
      since = new Date();
      await request(shared);
      const emailAgain = await waitForOtp(shared, since);
      await verify(inA.phone, emailAgain, 401);
      // Nor does B's phone, which holds no code, open anything.
      await verify(inB.phone, emailAgain, 401);
    });

    it('one phone in two compounds: one text, and its code lists both accounts', async () => {
      const a = await h.createTenant('Compound P1');
      const b = await h.createTenant('Compound P2');
      const phone = uniquePhone();
      const inA = await resident(a.id, { phone });
      const inB = await resident(b.id, { phone });
      expect(inA.email).not.toBe(inB.email);

      const since = new Date();
      await request(phone);
      const sms = await waitForSms(h, phone, since);
      expect(await countSms(h, phone, since, 500)).toBe(1);
      expect(await countEmails(inA.email, since, 100)).toBe(0);
      expect(await countEmails(inB.email, since, 100)).toBe(0);

      const verified = await verify(phone, sms.code);
      expect(verified.accounts.map((x) => x.accountId).sort()).toEqual(
        [inA.id, inB.id].sort(),
      );
      const tokens = await h
        .http()
        .post(`${API}/auth/select-account`)
        .send({ loginTicket: verified.loginTicket, accountId: inB.id })
        .expect(200);
      expect(tokens.body).toMatchObject({ accountId: inB.id });
      // The ticket and the code are single use.
      await h
        .http()
        .post(`${API}/auth/select-account`)
        .send({ loginTicket: verified.loginTicket, accountId: inA.id })
        .expect(401);
      await verify(phone, sms.code, 401);
    });

    it('a new request ends the older code, which was sent by SMS too', async () => {
      const t = await h.createTenant('Compound newest');
      const r = await resident(t.id);
      let since = new Date();
      await request(r.phone);
      const first = await waitForSms(h, r.phone, since);
      await new Promise((resolve) => setTimeout(resolve, 20));
      since = new Date();
      await request(r.phone);
      const second = await waitForSms(h, r.phone, since);
      if (first.code !== second.code) await verify(r.phone, first.code, 401);
      expect((await verify(r.phone, second.code)).accounts).toHaveLength(1);
    });

    it('five wrong guesses burn an SMS code like an emailed one', async () => {
      const t = await h.createTenant('Compound burnt');
      const r = await resident(t.id);
      // A wrong guess spends an attempt; five burn the SMS code.
      const since = new Date();
      await request(r.phone);
      const sms = await waitForSms(h, r.phone, since);
      const wrong = sms.code === '000000' ? '000001' : '000000';
      for (let i = 0; i < 5; i++) await verify(r.phone, wrong, 401);
      await verify(r.phone, sms.code, 401);
      const hash = hashOf('phone', r.phone);
      expect(
        await read.security({
          event: 'otp.challenge_exhausted',
          identifierHash: hash,
        }),
      ).toHaveLength(1);
    });
  });

  it('never records or logs the number', async () => {
    const t = await h.createTenant('Compound privacy');
    const r = await resident(t.id);
    const since = new Date();
    await request(r.phone);
    await waitForSms(h, r.phone, since);
    const hash = hashOf('phone', r.phone);
    const rows = await read.security({ identifierHash: hash });
    expect(rows.length).toBeGreaterThan(0);
    const shown = JSON.stringify(rows);
    expect(shown).not.toContain(r.phone);
    expect(shown).not.toContain(r.phone.slice(3));
  });

  describe('catalog completeness', () => {
    it('every SMS security event has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of SMS_LOGIN_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...SMS_LOGIN_COVERAGE].sort());
    });
  });
});
