import { AccountsService } from '../../src/core/accounts/accounts.service';
import { LoginAlerts } from '../../src/core/auth/login-alerts';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { drainOutbox } from '../setup/outbox';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { requestAndVerify } from '../setup/login';
import { waitForMessage } from '../setup/mailpit';

const ANDROID_APP = 'Jiwar/1.4.0 (Android 14; Pixel 8)';
const CHROME_WIN = (v: number) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
const FIREFOX_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const INSTALL_A = '0192a5f0-1c2b-7d3e-8f40-00000000000a';
const INSTALL_B = '0192a5f0-1c2b-7d3e-8f40-00000000000b';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * The unusual-login alert (ADR 0036): a device never seen on the account
 * raises a critical alert (inbox and email) with a coarse device type and
 * the time — no IP, no place — and a "not me" that freezes the account and
 * ends every session. The first device is the baseline.
 */
describe('Unusual-login alert', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let globalDb: GlobalDbService;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    globalDb = h.moduleRef.get(GlobalDbService);
    c = await x.compound('Login Alert Court');
  });

  afterAll(() => h.close());

  async function someone() {
    const unit = await x.unit(c);
    // A tenant beside the owner: not a primary, so nothing else reacts.
    await x.resident(c, [unit.id]);
    return x.resident(c, [unit.id], 'tenant');
  }

  /** The real login, from a device. */
  async function login(
    p: { id: string; email: string },
    device: { ua: string; installId?: string },
  ): Promise<Tokens> {
    const verified = await requestAndVerify(h, p.email, p.email);
    let req = h
      .http()
      .post(`${API}/auth/select-account`)
      .set('User-Agent', device.ua);
    if (device.installId) req = req.set('X-Jiwar-Install-Id', device.installId);
    const res = await req
      .send({ loginTicket: verified.loginTicket, accountId: p.id })
      .expect(200);
    return res.body as Tokens;
  }

  const alerts = (accountId: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.notification.findMany({
        where: { accountId, kind: 'account.new_device_login' },
        orderBy: { createdAt: 'asc' },
      }),
    );
  const devices = (accountId: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.knownDevice.findMany({
        where: { accountId },
        orderBy: { firstSeenAt: 'asc' },
      }),
    );
  const accountRow = (id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.account.findUniqueOrThrow({ where: { id } }),
    );

  /** The "not me" token from the alert email. */
  async function notMeToken(email: string, since: Date): Promise<string> {
    await drainOutbox(h);
    const message = await waitForMessage(email, since);
    const token = /\/a\/not-me#([0-9a-f-]{36}\.[0-9a-f]{64})/.exec(
      message.Text,
    )?.[1];
    expect(token).toBeDefined();
    return token!;
  }

  // --------------------------------------------------------------------------
  it('the first session is the baseline; the same device again raises nothing', async () => {
    const p = await someone();
    await login(p, { ua: ANDROID_APP, installId: INSTALL_A });
    expect(await alerts(p.id)).toEqual([]);
    const [first] = await devices(p.id);
    expect(first).toMatchObject({ source: 'app', deviceType: 'android' });
    // Only a keyed hash: never the install id itself.
    expect(first.deviceHash).not.toContain(INSTALL_A);
    expect(first.deviceHash).toMatch(/^[0-9a-f]{64}$/);

    await login(p, { ua: ANDROID_APP, installId: INSTALL_A });
    expect(await alerts(p.id)).toEqual([]);
    const again = await devices(p.id);
    expect(again).toHaveLength(1);
    expect(again[0].lastSeenAt.getTime()).toBeGreaterThan(
      first.lastSeenAt.getTime(),
    );
  });

  it('a new device raises a critical alert, inbox and email, without an IP', async () => {
    const p = await someone();
    await login(p, { ua: ANDROID_APP, installId: INSTALL_A });
    const since = new Date();
    await login(p, { ua: ANDROID_APP, installId: INSTALL_B });

    const [alert] = await alerts(p.id);
    expect(alert).toMatchObject({
      priority: 'critical',
      targetType: 'known_device',
    });
    expect(Object.keys(alert.params as object).sort()).toEqual([
      'at',
      'deviceType',
    ]);
    expect(alert.params).toMatchObject({ deviceType: 'android' });
    const text = JSON.stringify(alert);
    for (const ip of ['127.0.0.1', '::1', '::ffff:'])
      expect(text).not.toContain(ip);

    const [, second] = await devices(p.id);
    expect(alert.targetId).toBe(second.id);

    // The email: codes in the outbox, the link only in what was sent.
    const queued = await globalDb.outboxMessage.findFirstOrThrow({
      where: {
        recipientAccountId: p.id,
        templateKey: 'account.new_device_login',
      },
    });
    expect(Object.keys(queued.params as object).sort()).toEqual([
      'actionTokenId',
      'at',
      'compoundName',
      'deviceType',
      'timeZone',
    ]);
    const token = await notMeToken(p.email, since);
    expect(JSON.stringify(queued)).not.toContain(token.split('.')[1]);

    const events = await auditReaders(h).security({
      event: 'login.new_device',
      accountId: p.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({
      deviceId: second.id,
      deviceType: 'android',
    });
  });

  it('a browser is its family and OS: a new version is the same, another browser is new', async () => {
    const p = await someone();
    await login(p, { ua: CHROME_WIN(128) });
    await login(p, { ua: CHROME_WIN(129) });
    expect(await alerts(p.id)).toEqual([]);
    await login(p, { ua: FIREFOX_LINUX });
    const [alert] = await alerts(p.id);
    expect(alert.params).toMatchObject({ deviceType: 'desktop_web' });
  });

  it('"not me" from the email freezes the account, keeps the phone, ends every session, once', async () => {
    const p = await someone();
    const own = await login(p, { ua: ANDROID_APP, installId: INSTALL_A });
    const since = new Date();
    await login(p, { ua: FIREFOX_LINUX });
    const token = await notMeToken(p.email, since);

    await h.http().post(`${API}/public/not-me`).send({ token }).expect(204);
    const row = await accountRow(p.id);
    expect(row.status).toBe('frozen');
    expect(row.phone).toBe(p.phone);
    await h
      .http()
      .get(`${API}/me`)
      .set('Authorization', `Bearer ${own.accessToken}`)
      .expect(401);
    await h
      .http()
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: own.refreshToken })
      .expect(401);
    const [, disowned] = await devices(p.id);
    expect(disowned.disownedAt).not.toBeNull();

    const frozen = await auditReaders(h).tenant(c.tenantId, {
      action: 'account.frozen',
      targetId: p.id,
    });
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({
      actorType: 'account',
      actorId: p.id,
      changes: { status: { from: 'active', to: 'frozen' } },
      metadata: { reasonCode: 'login_not_me' },
    });
    const freeze = await x.asManager(c, () =>
      x.prisma.tenant.accountFreeze.findFirstOrThrow({
        where: { accountId: p.id },
      }),
    );
    expect(freeze).toMatchObject({
      reason: 'login_not_me',
      releasedPhoneHash: null,
    });

    // Used once.
    const again = await h
      .http()
      .post(`${API}/public/not-me`)
      .send({ token })
      .expect(404);
    expect((again.body as { code: string }).code).toBe('ACTION_TOKEN_INVALID');

    // The manager reopens it, with the same phone.
    await x.asManager(c, () =>
      h.moduleRef.get(AccountsService).reactivate(p.id),
    );
    expect((await accountRow(p.id)).status).toBe('active');
  });

  it('"not me" from the app acts on the device the alert named', async () => {
    const p = await someone();
    await login(p, { ua: ANDROID_APP, installId: INSTALL_A });
    const other = await login(p, { ua: ANDROID_APP, installId: INSTALL_B });
    const [alert] = await alerts(p.id);
    await h
      .http()
      .post(`${API}/me/devices/${alert.targetId}/not-me`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(204);
    expect((await accountRow(p.id)).status).toBe('frozen');
    // Its own session ended too.
    await h
      .http()
      .get(`${API}/me`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(401);
    const events = await auditReaders(h).security({
      event: 'account.not_me',
      accountId: p.id,
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      via: 'app',
      deviceId: alert.targetId,
    });
  });

  it('another account’s device, or a forged link, is not found', async () => {
    const p = await someone();
    const q = await someone();
    await login(q, { ua: FIREFOX_LINUX });
    const [qDevice] = await devices(q.id);
    const own = await login(p, { ua: FIREFOX_LINUX });
    const res = await h
      .http()
      .post(`${API}/me/devices/${qDevice.id}/not-me`)
      .set('Authorization', `Bearer ${own.accessToken}`)
      .expect(404);
    expect((res.body as { code: string }).code).toBe('DEVICE_NOT_FOUND');
    for (const token of ['x', `${qDevice.id}.${'0'.repeat(64)}`]) {
      const forged = await h
        .http()
        .post(`${API}/public/not-me`)
        .send({ token })
        .expect(404);
      expect((forged.body as { code: string }).code).toBe(
        'ACTION_TOKEN_INVALID',
      );
    }
    expect((await accountRow(q.id)).status).toBe('active');
  });

  it('two first logins at once: one baseline, one alert', async () => {
    const alertsService = h.moduleRef.get(LoginAlerts);
    for (let i = 0; i < 5; i++) {
      const p = await someone();
      const who = { accountId: p.id, tenantId: c.tenantId };
      await Promise.all([
        alertsService.recordLogin(who, { userAgent: CHROME_WIN(129) }),
        alertsService.recordLogin(who, { userAgent: FIREFOX_LINUX }),
      ]);
      expect(await devices(p.id)).toHaveLength(2);
      expect(await alerts(p.id)).toHaveLength(1);
    }
  });
});
