import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { countEmails, waitForMessage, waitForOtp } from '../setup/mailpit';

interface Verified {
  loginTicket: string;
  accounts: { accountId: string; tenantName: string; accountType: string }[];
}
interface Tokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

/**
 * Exit criteria 6 and 7: the login bootstrap finds accounts across tenants
 * without exposing other tenants' data, and a person with accounts in two
 * tenants gets each one separately. Codes are read from Mailpit —
 * OTP_FIXED_CODE is unset for this run (test/setup/test-env.ts).
 */
describe('Login bootstrap', () => {
  let h: HttpHarness;

  beforeAll(async () => {
    expect(process.env.OTP_FIXED_CODE).toBeUndefined();
    h = await createHttpHarness();
  });

  afterAll(() => h.close());

  async function requestCode(
    identifier: string,
    email: string,
  ): Promise<string> {
    const since = new Date();
    await h
      .http()
      .post(`${API}/auth/otp/request`)
      .send({ identifier })
      .expect(202);
    return waitForOtp(email, since);
  }

  async function verify(identifier: string, code: string): Promise<Verified> {
    const res = await h
      .http()
      .post(`${API}/auth/otp/verify`)
      .send({ identifier, code })
      .expect(200);
    return res.body as Verified;
  }

  async function select(
    loginTicket: string,
    accountId: string,
  ): Promise<Tokens> {
    const res = await h
      .http()
      .post(`${API}/auth/select-account`)
      .send({ loginTicket, accountId })
      .expect(200);
    return res.body as Tokens;
  }

  async function login(
    identifier: string,
    email: string,
    accountId: string,
  ): Promise<Tokens> {
    const verified = await verify(
      identifier,
      await requestCode(identifier, email),
    );
    return select(verified.loginTicket, accountId);
  }

  // --------------------------------------------------------------------------
  describe('6. OTP request/verify exposes nothing from other tenants', () => {
    it('lists only the accounts behind the identifier', async () => {
      const a = await h.createTenant('Compound A');
      const b = await h.createTenant('Compound B');
      const email = uniqueEmail('only-a');
      const account = await h.createAccount(a.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      // Noise in another tenant.
      await h.createAccount(b.id, {
        type: 'resident',
        email: uniqueEmail('other'),
        phone: uniquePhone(),
      });

      const verified = await verify(email, await requestCode(email, email));

      expect(verified.accounts).toEqual([
        { accountId: account.id, tenantName: a.name, accountType: 'resident' },
      ]);
      expect(Object.keys(verified).sort()).toEqual(['accounts', 'loginTicket']);
      const body = JSON.stringify(verified);
      expect(body).not.toContain(b.id);
      expect(body).not.toContain(b.name);
    });

    it('unknown identifiers get the identical request response', async () => {
      const email = uniqueEmail('known');
      const tenant = await h.createTenant('Compound K');
      await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });

      const known = await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: email });
      const unknown = await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: uniqueEmail('nobody') });
      const unknownPhone = await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: uniquePhone() });

      for (const res of [unknown, unknownPhone]) {
        expect(res.status).toBe(known.status);
        expect(res.text).toBe(known.text);
      }
      expect(known.status).toBe(202);
    });

    it('a wrong code and an unknown identifier fail the same way', async () => {
      const email = uniqueEmail('wrong');
      const tenant = await h.createTenant('Compound W');
      await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      const code = await requestCode(email, email);
      const wrong = code === '000000' ? '000001' : '000000';

      const known = await h
        .http()
        .post(`${API}/auth/otp/verify`)
        .send({ identifier: email, code: wrong });
      const unknown = await h
        .http()
        .post(`${API}/auth/otp/verify`)
        .send({ identifier: uniqueEmail('nobody'), code: wrong });

      for (const res of [known, unknown]) {
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({
          code: 'OTP_INVALID',
          message: 'Invalid or expired code',
        });
      }
    });

    it('rate limits unknown and known identifiers alike', async () => {
      const email = uniqueEmail('limited');
      const tenant = await h.createTenant('Compound L');
      await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      const unknown = uniqueEmail('limited-nobody');

      const statuses = async (identifier: string) => {
        const out: number[] = [];
        for (let i = 0; i < 6; i++) {
          out.push(
            (
              await h
                .http()
                .post(`${API}/auth/otp/request`)
                .send({ identifier })
            ).status,
          );
        }
        return out;
      };
      const expected = [202, 202, 202, 202, 202, 429];
      expect(await statuses(email)).toEqual(expected);
      expect(await statuses(unknown)).toEqual(expected);
    });
  });

  // --------------------------------------------------------------------------
  describe('7. one person, accounts in two tenants', () => {
    it('logs into each tenant separately and sees only its data', async () => {
      const a = await h.createTenant('Compound A');
      const b = await h.createTenant('Compound B');
      const phone = uniquePhone();
      const email = uniqueEmail('both');
      const inA = await h.createAccount(a.id, {
        type: 'manager',
        email,
        phone,
      });
      const inB = await h.createAccount(b.id, {
        type: 'manager',
        email,
        phone,
      });

      // Log in by phone (typed in local format); one email, one code.
      const local = `0${phone.slice(3)}`;
      const since = new Date();
      const verified = await verify(local, await requestCode(local, email));
      expect(await countEmails(email, since)).toBe(1);
      expect(verified.accounts.map((x) => x.accountId).sort()).toEqual(
        [inA.id, inB.id].sort(),
      );

      const tokensA = await select(verified.loginTicket, inA.id);
      await h
        .http()
        .post(`${API}/units`)
        .set('Authorization', `Bearer ${tokensA.accessToken}`)
        .send({ code: 'ONLY-A' })
        .expect(201);

      // The ticket is single use.
      await h
        .http()
        .post(`${API}/auth/select-account`)
        .send({ loginTicket: verified.loginTicket, accountId: inB.id })
        .expect(401);

      const tokensB = await login(local, email, inB.id);
      await h
        .http()
        .post(`${API}/units`)
        .set('Authorization', `Bearer ${tokensB.accessToken}`)
        .send({ code: 'ONLY-B' })
        .expect(201);

      const unitsA = await h
        .http()
        .get(`${API}/units`)
        .set('Authorization', `Bearer ${tokensA.accessToken}`)
        .expect(200);
      const unitsB = await h
        .http()
        .get(`${API}/units`)
        .set('Authorization', `Bearer ${tokensB.accessToken}`)
        .expect(200);
      expect(
        (unitsA.body as { data: { code: string }[] }).data.map((u) => u.code),
      ).toEqual(['ONLY-A']);
      expect(
        (unitsB.body as { data: { code: string }[] }).data.map((u) => u.code),
      ).toEqual(['ONLY-B']);

      const meA = await h
        .http()
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${tokensA.accessToken}`)
        .expect(200);
      expect(meA.body).toMatchObject({ id: inA.id });
    });

    it("with different emails, each code unlocks only its own tenant's account", async () => {
      const a = await h.createTenant('Compound A');
      const b = await h.createTenant('Compound B');
      const phone = uniquePhone();
      const emailA = uniqueEmail('mail-a');
      const emailB = uniqueEmail('mail-b');
      const inA = await h.createAccount(a.id, {
        type: 'resident',
        email: emailA,
        phone,
      });
      const inB = await h.createAccount(b.id, {
        type: 'resident',
        email: emailB,
        phone,
      });

      const since = new Date();
      await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: phone })
        .expect(202);
      const codeA = await waitForOtp(emailA, since);
      const codeB = await waitForOtp(emailB, since);

      const viaA = await verify(phone, codeA);
      expect(viaA.accounts).toEqual([
        { accountId: inA.id, tenantName: a.name, accountType: 'resident' },
      ]);
      await h
        .http()
        .post(`${API}/auth/select-account`)
        .send({ loginTicket: viaA.loginTicket, accountId: inB.id })
        .expect(401);

      const viaB = await verify(phone, codeB);
      expect(viaB.accounts).toEqual([
        { accountId: inB.id, tenantName: b.name, accountType: 'resident' },
      ]);
    });
  });

  // --------------------------------------------------------------------------
  describe('OTP email language (Accept-Language)', () => {
    async function emailFor(acceptLanguage?: string) {
      const email = uniqueEmail('lang');
      const tenant = await h.createTenant('Compound Lang');
      await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      const since = new Date();
      const req = h.http().post(`${API}/auth/otp/request`);
      if (acceptLanguage) void req.set('Accept-Language', acceptLanguage);
      const res = await req.send({ identifier: email }).expect(202);
      expect(res.body).toMatchObject({ code: 'OTP_REQUESTED' });
      return waitForMessage(email, since);
    }

    it('sends English when the client asks for it', async () => {
      const msg = await emailFor('en-US,en;q=0.9');
      expect(msg.Subject).toBe('Your Jiwar login code');
      expect(msg.HTML).toContain('dir="ltr"');
      expect(msg.Text).toMatch(/\b\d{6}\b/);
    });

    it('sends Arabic (RTL) by default', async () => {
      const msg = await emailFor();
      expect(msg.Subject).toBe('رمز الدخول إلى جوار');
      expect(msg.HTML).toContain('dir="rtl"');
      expect(msg.Text).toMatch(/\b\d{6}\b/);
    });

    it('sends Arabic for unsupported languages', async () => {
      const msg = await emailFor('fr-FR,fr;q=0.9');
      expect(msg.Subject).toBe('رمز الدخول إلى جوار');
    });
  });

  describe('code lifecycle', () => {
    it('a new request invalidates the previous code', async () => {
      const email = uniqueEmail('newer');
      const tenant = await h.createTenant('Compound N');
      await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });

      let first = await requestCode(email, email);
      let second = await requestCode(email, email);
      // Two random 6-digit codes collide one time in a million; retry then.
      for (let i = 0; first === second && i < 3; i++) {
        first = second;
        second = await requestCode(email, email);
      }
      expect(second).not.toBe(first);

      await h
        .http()
        .post(`${API}/auth/otp/verify`)
        .send({ identifier: email, code: first })
        .expect(401);
      await verify(email, second);
    });

    it('a code works once', async () => {
      const email = uniqueEmail('once');
      const tenant = await h.createTenant('Compound O');
      await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      const code = await requestCode(email, email);
      await verify(email, code);
      await h
        .http()
        .post(`${API}/auth/otp/verify`)
        .send({ identifier: email, code })
        .expect(401);
    });

    it('five wrong attempts burn the code', async () => {
      const email = uniqueEmail('burn');
      const tenant = await h.createTenant('Compound B5');
      await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      const code = await requestCode(email, email);
      const wrong = code === '000000' ? '000001' : '000000';
      for (let i = 0; i < 5; i++) {
        await h
          .http()
          .post(`${API}/auth/otp/verify`)
          .send({ identifier: email, code: wrong })
          .expect(401);
      }
      await h
        .http()
        .post(`${API}/auth/otp/verify`)
        .send({ identifier: email, code })
        .expect(401);
    });
  });

  // --------------------------------------------------------------------------
  describe('sessions', () => {
    let tenant: { id: string; name: string };
    let managerToken: string;

    beforeAll(async () => {
      tenant = await h.createTenant('Compound S');
      const manager = await h.createAccount(tenant.id, {
        type: 'manager',
        email: uniqueEmail('mgr-s'),
        phone: uniquePhone(),
      });
      managerToken = await h.tokenFor({
        sub: manager.id,
        tid: tenant.id,
        typ: 'manager',
      });
    });

    async function residentSession(): Promise<Tokens> {
      const email = uniqueEmail('res-s');
      const account = await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      return login(email, email, account.id);
    }

    it('refresh rotates the token; replaying the old one revokes the session', async () => {
      const tokens = await residentSession();
      const first = await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);
      const rotated = first.body as Tokens;
      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);

      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
      // Reuse detection took the whole session down, including the new token.
      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: rotated.refreshToken })
        .expect(401);
    });

    it('a deactivated account cannot refresh', async () => {
      const tokens = await residentSession();
      await h
        .http()
        .patch(`${API}/accounts/${tokens.accountId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'inactive' })
        .expect(200);
      const res = await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
      expect(res.body).toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
    });

    it('a deactivated account can no longer request codes that work', async () => {
      const email = uniqueEmail('gone');
      const account = await h.createAccount(tenant.id, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      await h
        .http()
        .patch(`${API}/accounts/${account.id}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'inactive' })
        .expect(200);
      const since = new Date();
      await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: email })
        .expect(202);
      expect(await countEmails(email, since)).toBe(0);
    });

    it('logout ends the session', async () => {
      const tokens = await residentSession();
      await h
        .http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);
      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
    });
  });
});
