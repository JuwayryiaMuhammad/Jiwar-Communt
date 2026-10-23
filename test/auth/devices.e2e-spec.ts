import { LOGINS_RETENTION_SWEEP } from '../../src/core/accounts/account-self.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { communityHelpers, type Compound } from '../setup/community';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deviceLogin, requestAndVerify } from '../setup/login';

const ANDROID_APP = 'Jiwar/1.4.0 (Android 14; Pixel 8)';
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';
const INSTALL = '0192a5f0-1c2b-7d3e-8f40-0000000058a1';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}
interface Label {
  id: string;
  deviceType: string;
  os: string;
  client: string;
}
interface DeviceItem extends Label {
  firstSeenAt: string;
  lastSeenAt: string;
  liveSessions: number;
  isCurrent: boolean;
}
interface LoginItem {
  id: string;
  at: string;
  device: Label;
  isCurrent: boolean;
}

/**
 * The login history and the devices (ADR 0058): each login is recorded with
 * the device's coarse label (never an IP, a user agent or a place); a device
 * is signed out by its holder, ending exactly its sessions, and its next
 * login alerts as a new one.
 */
describe('Devices and the login history', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let globalDb: GlobalDbService;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    globalDb = h.moduleRef.get(GlobalDbService);
    c = await x.compound('Devices Court');
  });

  afterAll(() => h.close());

  async function someone() {
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    return x.resident(c, [unit.id], 'tenant');
  }

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
    return (
      await req
        .send({ loginTicket: verified.loginTicket, accountId: p.id })
        .expect(200)
    ).body as Tokens;
  }

  const list = <T>(r: { body: unknown }) => (r.body as { data: T[] }).data;
  const code = (r: { body: unknown }) => (r.body as { code: string }).code;
  const get = (path: string, t: Tokens) =>
    h
      .http()
      .get(`${API}${path}`)
      .set('Authorization', `Bearer ${t.accessToken}`);
  const post = (path: string, t: Tokens) =>
    h
      .http()
      .post(`${API}${path}`)
      .set('Authorization', `Bearer ${t.accessToken}`);

  const devices = async (t: Tokens) =>
    list<DeviceItem>(await get('/me/devices', t).expect(200));
  const logins = async (t: Tokens) =>
    list<LoginItem>(await get('/me/logins', t).expect(200));
  const alerts = (accountId: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.notification.count({
        where: { accountId, kind: 'account.new_device_login' },
      }),
    );

  // --------------------------------------------------------------------------
  it('records each login with the device label, never an IP or a user agent', async () => {
    const p = await someone();
    const app = await login(p, { ua: ANDROID_APP, installId: INSTALL });
    const web = await login(p, { ua: CHROME_WIN });

    const history = await logins(web);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      device: {
        deviceType: 'desktop_web',
        os: 'windows',
        client: 'chrome',
      },
      isCurrent: true,
    });
    expect(history[1]).toMatchObject({
      device: { deviceType: 'android', os: 'android', client: 'app' },
      isCurrent: false,
    });
    expect(new Date(history[0].at).getTime()).toBeGreaterThanOrEqual(
      new Date(history[1].at).getTime(),
    );
    const text = JSON.stringify(history);
    expect(text).not.toContain('Mozilla');
    expect(text).not.toContain('Jiwar/1.4.0');
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|::1/);
    // Only the holder's own.
    expect(await logins(app)).toHaveLength(2);
    const other = await someone();
    const theirs = await login(other, { ua: SAFARI_MAC });
    expect(await logins(theirs)).toHaveLength(1);

    // Paged, newest first.
    const first = await get('/me/logins?limit=1', web).expect(200);
    expect(list(first)).toHaveLength(1);
    const second = await get(
      `/me/logins?limit=1&cursor=${(first.body as { nextCursor: string }).nextCursor}`,
      web,
    ).expect(200);
    expect(list<LoginItem>(second)[0].id).toBe(history[1].id);

    // The sessions name their device.
    const sessions = list<{ device: Label | null }>(
      await get('/me/sessions', web).expect(200),
    );
    expect(sessions.map((s) => s.device?.client).sort()).toEqual([
      'app',
      'chrome',
    ]);
  });

  it('lists the devices with their live sessions and the current one', async () => {
    const p = await someone();
    const app = await login(p, { ua: ANDROID_APP, installId: INSTALL });
    await login(p, { ua: ANDROID_APP, installId: INSTALL });
    const web = await login(p, { ua: CHROME_WIN });
    const list = await devices(web);
    expect(list).toHaveLength(2);
    const phone = list.find((d) => d.client === 'app')!;
    const browser = list.find((d) => d.client === 'chrome')!;
    expect(phone).toMatchObject({ liveSessions: 2, isCurrent: false });
    expect(browser).toMatchObject({ liveSessions: 1, isCurrent: true });
    expect(JSON.stringify(list)).not.toContain('Mozilla');
    expect((await devices(app)).find((d) => d.isCurrent)!.id).toBe(phone.id);
  });

  it('a revoke ends exactly that device’s sessions; its next login alerts', async () => {
    const p = await someone();
    const app1 = await login(p, { ua: ANDROID_APP, installId: INSTALL });
    const app2 = await login(p, { ua: ANDROID_APP, installId: INSTALL });
    const web = await login(p, { ua: CHROME_WIN });
    const alertsBefore = await alerts(p.id);
    const phone = (await devices(web)).find((d) => d.client === 'app')!;

    const res = await post(`/me/devices/${phone.id}/revoke`, web).expect(200);
    expect(res.body).toEqual({ revoked: 2 });
    await get('/me', app1).expect(401);
    await get('/me', app2).expect(401);
    await get('/me', web).expect(200);
    for (const t of [app1, app2])
      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: t.refreshToken })
        .expect(401);
    // Again: nothing more to end.
    expect(
      (await post(`/me/devices/${phone.id}/revoke`, web).expect(200)).body,
    ).toEqual({ revoked: 0 });
    const listed = (await devices(web)).find((d) => d.id === phone.id)!;
    expect(listed.liveSessions).toBe(0);

    // The next login from it is treated as a new device: it alerts, and the
    // device is live again (the same row).
    const back = await login(p, { ua: ANDROID_APP, installId: INSTALL });
    expect(await alerts(p.id)).toBe(alertsBefore + 1);
    const again = (await devices(back)).find((d) => d.id === phone.id)!;
    expect(again).toMatchObject({ liveSessions: 1, isCurrent: true });
    const row = await x.asManager(c, () =>
      x.prisma.tenant.knownDevice.findUniqueOrThrow({
        where: { id: phone.id },
      }),
    );
    expect(row.revokedAt).toBeNull();
  });

  it('another account’s device, or a disowned one, is DEVICE_NOT_FOUND', async () => {
    const p = await someone();
    const mine = await login(p, { ua: CHROME_WIN });
    const q = await someone();
    const theirs = await login(q, { ua: SAFARI_MAC });
    const theirDevice = (await devices(theirs))[0];
    const res = await post(`/me/devices/${theirDevice.id}/revoke`, mine).expect(
      404,
    );
    expect(code(res)).toBe('DEVICE_NOT_FOUND');
    await get('/me', theirs).expect(200);

    // A disowned device ("not me") is no longer listed or revocable.
    const myDevice = (await devices(mine))[0];
    await x.asManager(c, () =>
      x.prisma.tenant.knownDevice.update({
        where: { id: myDevice.id },
        data: { disownedAt: new Date('2026-01-02T03:04:05.000Z') },
      }),
    );
    expect(await devices(mine)).toEqual([]);
    expect(
      code(await post(`/me/devices/${myDevice.id}/revoke`, mine).expect(404)),
    ).toBe('DEVICE_NOT_FOUND');
  });

  it('a login racing a revoke: never a live session on a revoked device', async () => {
    for (let i = 0; i < 5; i++) {
      const p = await someone();
      const who = { accountId: p.id, tenantId: c.tenantId };
      const web = await login(p, { ua: CHROME_WIN });
      await deviceLogin(h, who, { userAgent: ANDROID_APP, installId: INSTALL });
      const phone = (await devices(web)).find((d) => d.client === 'app')!;
      const alertsBefore = await alerts(p.id);

      const [revoked, sessionId] = await Promise.all([
        post(`/me/devices/${phone.id}/revoke`, web).then((r) => r.status),
        deviceLogin(h, who, { userAgent: ANDROID_APP, installId: INSTALL }),
      ]);
      expect(revoked).toBe(200);

      const device = await x.asManager(c, () =>
        x.prisma.tenant.knownDevice.findUniqueOrThrow({
          where: { id: phone.id },
        }),
      );
      const session = await globalDb.session.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(session.knownDeviceId).toBe(phone.id);
      if (device.revokedAt) {
        // The revoke came after the login: it ended that session too.
        expect(session.revokedAt).not.toBeNull();
        expect(await alerts(p.id)).toBe(alertsBefore);
      } else {
        // The login came after: the device is live again, and it alerted.
        expect(session.revokedAt).toBeNull();
        expect(await alerts(p.id)).toBe(alertsBefore + 1);
      }
      const live = await globalDb.session.count({
        where: {
          knownDeviceId: phone.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      expect(live > 0).toBe(device.revokedAt === null);
    }
  });

  it('a login is never changed, and goes after 90 days', async () => {
    const p = await someone();
    const t = await login(p, { ua: SAFARI_MAC });
    const [mine] = await logins(t);
    await expect(
      x.asManager(c, () =>
        x.prisma.tenant.accountLogin.update({
          where: { id: mine.id },
          data: { createdAt: new Date('2026-01-02T03:04:05.000Z') },
        }),
      ),
    ).rejects.toThrow(/permission denied for table account_logins/);

    const at = new Date(mine.at);
    const sweep = h.moduleRef.get(SweepRunner);
    // eslint-disable-next-line no-restricted-syntax -- a real 90 × 24 h: the logins purge is now − LOGIN_RETENTION_DAYS × 86_400_000
    const ninety = 90 * 86_400_000;
    await sweep.run(LOGINS_RETENTION_SWEEP, new Date(at.getTime() + ninety));
    expect(await logins(t)).toHaveLength(1);
    await sweep.run(
      LOGINS_RETENTION_SWEEP,
      new Date(at.getTime() + ninety + 1),
    );
    expect(await logins(t)).toEqual([]);
    // The device and the session stay.
    expect(await devices(t)).toHaveLength(1);
    await get('/me', t).expect(200);
  });
});
