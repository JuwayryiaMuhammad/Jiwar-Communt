import { JwtService } from '@nestjs/jwt';
import type { AccessTokenClaims } from '../../src/core/common/guards/access-token';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp, requestAndVerify, type Tokens } from '../setup/login';

/**
 * Access tokens name their session (`sid`), and the guard checks it on every
 * request: revoking a session cuts its access token at once (ADR 0004).
 */
describe('Sessions', () => {
  let h: HttpHarness;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness();
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  async function resident() {
    const tenant = await h.createTenant('Session Court');
    const email = uniqueEmail('session');
    const account = await h.createAccount(tenant.id, {
      type: 'resident',
      email,
      phone: uniquePhone(),
    });
    return { email, id: account.id, tenantId: tenant.id };
  }

  const me = (token: string) =>
    h.http().get(`${API}/accounts/me`).set('Authorization', `Bearer ${token}`);

  it('records user agent, IP and last use at login and at every refresh', async () => {
    const r = await resident();
    const verified = await requestAndVerify(h, r.email, r.email);
    const tokens = (
      await h
        .http()
        .post(`${API}/auth/select-account`)
        .set('User-Agent', 'login-client/1.0')
        .send({ loginTicket: verified.loginTicket, accountId: r.id })
        .expect(200)
    ).body as Tokens;
    const claims = h.moduleRef
      .get(JwtService)
      .decode<AccessTokenClaims>(tokens.accessToken);
    const started = await globalDb.session.findUniqueOrThrow({
      where: { id: claims.sid },
    });
    expect(started.accountId).toBe(r.id);
    expect(started.ip).toBeTruthy();
    expect(started.userAgent).toBe('login-client/1.0');
    expect(started.lastUsedAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await h
      .http()
      .post(`${API}/auth/refresh`)
      .set('User-Agent', 'refresh-client/2.0')
      .send({ refreshToken: tokens.refreshToken })
      .expect(200);
    const refreshed = await globalDb.session.findUniqueOrThrow({
      where: { id: claims.sid },
    });
    expect(refreshed.userAgent).toBe('refresh-client/2.0');
    expect(refreshed.lastUsedAt!.getTime()).toBeGreaterThan(
      started.lastUsedAt!.getTime(),
    );
  });

  it('logout cuts the access token immediately, not when it expires', async () => {
    const r = await resident();
    const tokens = await loginViaOtp(h, r.email, r.id);
    await me(tokens.accessToken).expect(200);
    await h
      .http()
      .post(`${API}/auth/logout`)
      .send({ refreshToken: tokens.refreshToken })
      .expect(204);
    const res = await me(tokens.accessToken).expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a token without sid, or naming another account’s session, is rejected', async () => {
    const r = await resident();
    const other = await resident();
    const jwt = h.moduleRef.get(JwtService);
    const noSid = await jwt.signAsync(
      { sub: r.id, tid: r.tenantId, typ: 'resident' },
      { expiresIn: 900, audience: 'tenant' },
    );
    await me(noSid).expect(401);

    const otherTokens = await loginViaOtp(h, other.email, other.id);
    const otherSid = jwt.decode<AccessTokenClaims>(otherTokens.accessToken).sid;
    const borrowed = await jwt.signAsync(
      {
        sub: r.id,
        tid: r.tenantId,
        typ: 'resident',
        sid: otherSid,
      } satisfies AccessTokenClaims,
      { expiresIn: 900, audience: 'tenant' },
    );
    await me(borrowed).expect(401);
  });
});
