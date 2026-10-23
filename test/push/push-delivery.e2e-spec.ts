import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { NotificationInput } from '../../src/core/notifications/notifier';
import { Notifier } from '../../src/core/notifications/notifier';
import {
  PUSH_BACKOFF_MS,
  PUSH_RETENTION_MS,
  PUSH_RETENTION_SWEEP,
  PushProcessor,
} from '../../src/core/push/push-processor';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { communityHelpers, type Compound } from '../setup/community';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  drainPush,
  FakePushTransport,
  INSTALL_2,
  pushToken,
  registerPush,
} from '../setup/push';
import { clock } from '../setup/compound-clock';

const hhmm = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const PARCEL: NotificationInput = {
  kind: 'parcel.arrived',
  params: {
    carrier: 'aramex',
    pieces: 2,
    receivedAt: '2026-10-19T09:00:00.000Z',
    unitCode: 'B-12',
  },
  targetId: '0192a5f0-1c2b-7d3e-8f40-0000000000f1',
};
const NEW_LOGIN: NotificationInput = {
  kind: 'account.new_device_login',
  params: { deviceType: 'android', at: '2026-10-19T09:00:00.000Z' },
  targetId: '0192a5f0-1c2b-7d3e-8f40-0000000000f2',
};

/**
 * Push delivery (ADR 0041): every notification written to the inbox is
 * queued for the recipient's devices in the same transaction and sent
 * through the transport — here a fake: nothing leaves the process.
 */
describe('Push delivery (ADR 0041)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let globalDb: GlobalDbService;
  let c: Compound;
  const fake = new FakePushTransport();

  beforeAll(async () => {
    h = await createHttpHarness({ push: fake });
    x = communityHelpers(h);
    globalDb = h.moduleRef.get(GlobalDbService);
    c = await x.compound('Push Delivery Court');
  }, 120_000);

  afterAll(() => h.close());

  beforeEach(async () => {
    fake.reset();
    await globalDb.pushDelivery.deleteMany({});
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A resident with one registered phone. */
  async function someone(opts: { device?: boolean } = {}) {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    const push = pushToken();
    if (opts.device !== false)
      await registerPush(h, token, { token: push }).expect(204);
    return { ...p, token, push };
  }

  const notify = (accountIds: string[], input: NotificationInput = PARCEL) =>
    x.asManager(c, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          h.moduleRef.get(Notifier).notify(tx, accountIds, input),
        ),
    );

  const inbox = (accountId: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.notification.findMany({
        where: { accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  const deliveries = (accountId: string) =>
    globalDb.pushDelivery.findMany({
      where: { device: { accountId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  const prefs = (token: string, body: object) =>
    h
      .http()
      .patch(`${API}/me/notification-preferences`)
      .set(bearer(token))
      .send(body)
      .expect(200);

  // --------------------------------------------------------------------------
  describe('what is sent', () => {
    it('one push per notification and device: the text in Arabic by default, the data, the collapse id', async () => {
      const p = await someone();
      await notify([p.id]);
      const [n] = await inbox(p.id);
      const [queued] = await deliveries(p.id);
      expect(queued).toMatchObject({
        tenantId: c.tenantId,
        notificationId: n.id,
        status: 'pending',
        attempts: 0,
      });

      expect(await drainPush(h)).toMatchObject({ sent: 1, dead: 0 });
      expect(fake.sent).toEqual([
        {
          token: p.push,
          title: 'وصل طرد',
          body: 'يوجد طرد للوحدة B-12 عند البوابة.',
          data: {
            notificationId: n.id,
            kind: 'parcel.arrived',
            targetType: 'parcel',
            targetId: PARCEL.targetId,
          },
          critical: false,
          collapseId: n.id,
        },
      ]);
      const [sent] = await deliveries(p.id);
      expect(sent).toMatchObject({
        status: 'sent',
        attempts: 1,
        lockedUntil: null,
        lastErrorCode: null,
      });
      expect(sent.sentAt).toBeInstanceOf(Date);

      // At most once: nothing is left to send, whatever the hour.
      // eslint-disable-next-line no-restricted-syntax -- any later instant: push claims compare next_attempt_at with now
      expect(await drainPush(h, new Date(Date.now() + 86_400_000))).toEqual({
        sent: 0,
        retried: 0,
        dead: 0,
        dropped: 0,
      });
      expect(fake.sent).toHaveLength(1);
    });

    it("is written in the account's language", async () => {
      const p = await someone();
      await h
        .http()
        .patch(`${API}/me/locale`)
        .set(bearer(p.token))
        .send({ locale: 'en' })
        .expect(200);
      await notify([p.id]);
      await drainPush(h);
      expect(fake.sent[0]).toMatchObject({
        title: 'A parcel has arrived',
        body: 'A parcel for unit B-12 is at the gate.',
      });
    });

    it('every device of every recipient gets it once; an account with no device gets none', async () => {
      const two = await someone();
      const second = pushToken();
      await registerPush(h, two.token, { token: second }, INSTALL_2).expect(
        204,
      );
      const one = await someone();
      const none = await someone({ device: false });

      await notify([two.id, one.id, none.id, two.id]);
      expect(await inbox(none.id)).toHaveLength(1);
      expect(await deliveries(none.id)).toEqual([]);
      await drainPush(h);
      expect(fake.sent.map((m) => m.token).sort()).toEqual(
        [two.push, second, one.push].sort(),
      );
    });

    it('a successful push stamps the device as used', async () => {
      const p = await someone();
      const before = await globalDb.pushDevice.findFirstOrThrow({
        where: { accountId: p.id },
      });
      await notify([p.id]);
      const at = new Date(Date.now() + 3600_000);
      await drainPush(h, at);
      const after = await globalDb.pushDevice.findFirstOrThrow({
        where: { accountId: p.id },
      });
      expect(after.lastUsedAt).toEqual(at);
      expect(after.lastUsedAt.getTime()).toBeGreaterThan(
        before.lastUsedAt.getTime(),
      );
    });

    it("never says a visitor's or a worker's name: the inbox keeps it, the push is generic", async () => {
      const p = await someone();
      const inputs: NotificationInput[] = [
        {
          kind: 'worker.entered',
          params: {
            unitCode: 'B-12',
            gateName: 'North Gate',
            workerName: 'Zeinab Worker',
          },
          targetId: PARCEL.targetId,
        },
        {
          kind: 'gate.approval_requested',
          params: {
            unitCode: 'B-12',
            requestKind: 'visitor',
            partySize: 1,
            gateName: 'North Gate',
            visitorName: 'Yusuf Visitor',
          },
          targetId: PARCEL.targetId,
        },
      ];
      for (const input of inputs) await notify([p.id], input);
      expect(JSON.stringify(await inbox(p.id))).toContain('Zeinab Worker');

      await drainPush(h);
      expect(fake.sent).toHaveLength(2);
      const text = JSON.stringify(fake.sent);
      expect(text).not.toContain('Zeinab');
      expect(text).not.toContain('Yusuf');
      expect(fake.sent.map((m) => m.title).sort()).toEqual(
        ['وصل العامل', 'زائر عند البوابة'].sort(),
      );
      expect(
        fake.sent.find((m) => m.data.kind === 'gate.approval_requested'),
      ).toMatchObject({ critical: true });
    });

    it('is rendered from the notification as it is when sent: a deleted one is not pushed', async () => {
      const p = await someone();
      await notify([p.id]);
      await x.asManager(c, () =>
        x.prisma.tenant.notification.deleteMany({ where: { accountId: p.id } }),
      );
      expect(await drainPush(h)).toMatchObject({ sent: 0, dropped: 1 });
      expect(fake.sent).toEqual([]);
      expect(await deliveries(p.id)).toEqual([]);
    });

    it('a notification that rolls back queues nothing', async () => {
      const p = await someone();
      await expect(
        x.asManager(c, () =>
          h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
            await h.moduleRef.get(Notifier).notify(tx, [p.id], PARCEL);
            throw new Error('rolled back');
          }),
        ),
      ).rejects.toThrow('rolled back');
      expect(await inbox(p.id)).toEqual([]);
      expect(await deliveries(p.id)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  describe('preferences (ADR 0036)', () => {
    it('a muted category gets no push; the inbox row is written as before', async () => {
      const p = await someone();
      await prefs(p.token, {
        categories: [{ category: 'parcels', push: false }],
      });
      await notify([p.id]);
      expect(await inbox(p.id)).toHaveLength(1);
      expect(await deliveries(p.id)).toEqual([]);

      // Email off does not mute the push, and another category still goes.
      await prefs(p.token, {
        categories: [{ category: 'parcels', push: true, email: false }],
      });
      await notify([p.id]);
      expect(await deliveries(p.id)).toHaveLength(1);
    });

    it('quiet hours and a pause mean no push at all, not a later one', async () => {
      const quiet = await someone();
      const m = clock().minute;
      await prefs(quiet.token, {
        quietHours: { start: hhmm(m - 60), end: hhmm(m + 60) },
      });
      const paused = await someone();
      await prefs(paused.token, { pause: '8h' });
      const stopped = await someone();
      await prefs(stopped.token, { pause: 'until_resumed' });
      const free = await someone();

      await notify([quiet.id, paused.id, stopped.id, free.id]);
      for (const p of [quiet, paused, stopped]) {
        expect(await inbox(p.id)).toHaveLength(1);
        expect(await deliveries(p.id)).toEqual([]);
      }
      expect(await deliveries(free.id)).toHaveLength(1);

      // Nothing was held: lifting the pause releases nothing.
      await prefs(paused.token, { pause: null });
      await drainPush(h, new Date(Date.now() + 9 * 3600_000));
      expect(fake.sent.map((sent) => sent.token)).toEqual([free.push]);
    });

    it('a critical kind is pushed through a muted category, quiet hours and a pause', async () => {
      const p = await someone();
      const m = clock().minute;
      await prefs(p.token, {
        categories: [{ category: 'account_security', push: false }],
        quietHours: { start: hhmm(m - 60), end: hhmm(m + 60) },
        pause: 'until_resumed',
      });
      await notify([p.id], NEW_LOGIN);
      await drainPush(h);
      expect(fake.sent).toMatchObject([
        {
          token: p.push,
          title: 'تسجيل دخول جديد إلى حسابك',
          critical: true,
          data: {
            kind: 'account.new_device_login',
            targetType: 'known_device',
          },
        },
      ]);
    });
  });

  // --------------------------------------------------------------------------
  describe('failures', () => {
    it('UNREGISTERED deletes the token and what was queued for it; other devices are untouched', async () => {
      const p = await someone();
      const good = pushToken();
      await registerPush(h, p.token, { token: good }, INSTALL_2).expect(204);
      await notify([p.id]);
      await notify([p.id]);
      fake.failToken(p.push, {
        ok: false,
        kind: 'token',
        code: 'UNREGISTERED',
      });
      await drainPush(h);

      const left = await globalDb.pushDevice.findMany({
        where: { accountId: p.id },
      });
      expect(left.map((d) => d.token)).toEqual([good]);
      // The dead token was tried once, not once per notification.
      expect(fake.to(p.push)).toHaveLength(1);
      expect(fake.to(good)).toHaveLength(2);
      expect((await deliveries(p.id)).map((d) => d.status)).toEqual([
        'sent',
        'sent',
      ]);
    });

    it('a refused payload is given up and recorded; the token stays', async () => {
      const p = await someone();
      await notify([p.id]);
      fake.next({ ok: false, kind: 'payload', code: 'INVALID_PAYLOAD' });
      expect(await drainPush(h)).toMatchObject({ dead: 1, sent: 0 });
      expect(await deliveries(p.id)).toMatchObject([
        { status: 'dead', lastErrorCode: 'INVALID_PAYLOAD', attempts: 1 },
      ]);
      expect(
        await globalDb.pushDevice.count({ where: { accountId: p.id } }),
      ).toBe(1);
      // Dead is final.
      // eslint-disable-next-line no-restricted-syntax -- any later instant: push claims compare next_attempt_at with now
      await drainPush(h, new Date(Date.now() + 86_400_000));
      expect(fake.sent).toHaveLength(1);
    });

    it('a transient failure is retried after the backoff, then sent once', async () => {
      const p = await someone();
      await notify([p.id]);
      const t0 = new Date(Date.now() + 1000);
      fake.next({ ok: false, kind: 'transient', code: 'UNAVAILABLE' });
      expect(await drainPush(h, t0)).toMatchObject({ retried: 1, sent: 0 });
      expect(await deliveries(p.id)).toMatchObject([
        {
          status: 'pending',
          attempts: 1,
          lastErrorCode: 'UNAVAILABLE',
          lockedUntil: null,
          nextAttemptAt: new Date(t0.getTime() + PUSH_BACKOFF_MS[0]),
        },
      ]);
      // Not due yet.
      await drainPush(h, new Date(t0.getTime() + PUSH_BACKOFF_MS[0] - 1));
      expect(fake.sent).toHaveLength(1);

      await drainPush(h, new Date(t0.getTime() + PUSH_BACKOFF_MS[0]));
      expect(fake.sent).toHaveLength(2);
      expect(await deliveries(p.id)).toMatchObject([
        { status: 'sent', attempts: 2 },
      ]);
    });

    it('waits at least as long as the provider asks (Retry-After)', async () => {
      const p = await someone();
      await notify([p.id]);
      const t0 = new Date(Date.now() + 1000);
      fake.next({
        ok: false,
        kind: 'transient',
        code: 'QUOTA_EXCEEDED',
        retryAfterMs: 600_000,
      });
      await drainPush(h, t0);
      expect((await deliveries(p.id))[0].nextAttemptAt).toEqual(
        new Date(t0.getTime() + 600_000),
      );
    });

    it('gives up after PUSH_MAX_ATTEMPTS and records the last error', async () => {
      const p = await someone();
      await notify([p.id]);
      fake.failToken(p.push, {
        ok: false,
        kind: 'transient',
        code: 'UNAVAILABLE',
      });
      let at = Date.now() + 1000;
      const outcomes: string[] = [];
      for (let i = 0; i < 8; i++) {
        const run = await h.moduleRef
          .get(PushProcessor)
          .processDue(new Date(at));
        outcomes.push(run.retried ? 'retried' : run.dead ? 'dead' : 'idle');
        at += PUSH_BACKOFF_MS[PUSH_BACKOFF_MS.length - 1];
      }
      expect(outcomes).toEqual([
        'retried',
        'retried',
        'retried',
        'retried',
        'dead',
        'idle',
        'idle',
        'idle',
      ]);
      expect(fake.sent).toHaveLength(5);
      expect(await deliveries(p.id)).toMatchObject([
        { status: 'dead', attempts: 5, lastErrorCode: 'UNAVAILABLE' },
      ]);
      // A transient failure never costs the token.
      expect(
        await globalDb.pushDevice.count({ where: { accountId: p.id } }),
      ).toBe(1);
    });

    it('an unknown outcome is never sent again', async () => {
      const lost = await someone();
      await notify([lost.id]);
      fake.next({ ok: false, kind: 'unknown', code: 'TimeoutError' });
      expect(await drainPush(h)).toMatchObject({ dead: 1 });

      // A transport that throws is the same: nobody knows what happened.
      const thrown = await someone();
      await notify([thrown.id]);
      fake.nextRun(() => {
        throw Object.assign(new Error('boom'), { name: 'BoomError' });
      });
      expect(await drainPush(h)).toMatchObject({ dead: 1 });

      expect(await deliveries(lost.id)).toMatchObject([
        { status: 'dead', lastErrorCode: 'TimeoutError' },
      ]);
      expect(await deliveries(thrown.id)).toMatchObject([
        { status: 'dead', lastErrorCode: 'BoomError' },
      ]);
      // eslint-disable-next-line no-restricted-syntax -- any later instant: push claims compare next_attempt_at with now
      await drainPush(h, new Date(Date.now() + 86_400_000));
      expect(fake.sent).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  describe('the session behind a device', () => {
    it('a device whose session ended or expired is not pushed to, and is removed', async () => {
      // Ended behind the hooks' back, as a missed path would leave it.
      const ended = await someone();
      const expired = await someone();
      const live = await someone();
      const sessionOf = async (accountId: string) =>
        (await globalDb.pushDevice.findFirstOrThrow({ where: { accountId } }))
          .sessionId;
      await globalDb.session.update({
        where: { id: await sessionOf(ended.id) },
        data: { revokedAt: new Date() },
      });
      await globalDb.session.update({
        where: { id: await sessionOf(expired.id) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await notify([ended.id, expired.id, live.id]);
      await drainPush(h);
      expect(fake.sent.map((m) => m.token)).toEqual([live.push]);
      for (const p of [ended, expired])
        expect(
          await globalDb.pushDevice.count({ where: { accountId: p.id } }),
        ).toBe(0);
    });

    it('an account that is no longer active is not pushed to', async () => {
      const p = await someone();
      await notify([p.id]);
      // The status alone, without the lifecycle that would drop the device.
      await x.asManager(c, () =>
        x.prisma.tenant.account.update({
          where: { id: p.id },
          data: { status: 'inactive' },
        }),
      );
      await drainPush(h);
      expect(fake.sent).toEqual([]);
      expect(
        await globalDb.pushDevice.count({ where: { accountId: p.id } }),
      ).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  it('retention deletes finished rows after a week, and nothing still to send', async () => {
    const done = await someone();
    const waiting = await someone();
    await notify([done.id]);
    await drainPush(h);
    await notify([waiting.id]);
    const later = new Date(Date.now() + PUSH_RETENTION_MS + 60_000);
    const sweep = h.moduleRef.get(SweepRunner);
    expect(await sweep.run(PUSH_RETENTION_SWEEP, new Date())).toBe(0);
    expect(await sweep.run(PUSH_RETENTION_SWEEP, later)).toBe(1);
    expect(await deliveries(done.id)).toEqual([]);
    expect(await deliveries(waiting.id)).toHaveLength(1);
  });
});

/**
 * Push not configured (no FCM settings): the app runs as before. Tokens
 * are still accepted, so devices are ready the day the keys arrive, but
 * nothing is queued and nothing is sent.
 */
describe('Push delivery — not configured', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('Push Off Court');
  }, 120_000);

  afterAll(() => h.close());

  it('registers a token, writes the inbox, queues no push, and the worker does not poll', async () => {
    const globalDb = h.moduleRef.get(GlobalDbService);
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    await registerPush(h, token, { token: pushToken() }).expect(204);
    expect(
      await globalDb.pushDevice.count({ where: { accountId: p.id } }),
    ).toBe(1);

    const written = await x.asManager(c, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          h.moduleRef.get(Notifier).notify(tx, [p.id], PARCEL),
        ),
    );
    expect(written).toBe(1);
    expect(
      await globalDb.pushDelivery.count({
        where: { device: { accountId: p.id } },
      }),
    ).toBe(0);

    const processor = h.moduleRef.get(PushProcessor);
    expect(processor.polling).toBe(false);
    expect(await processor.processDue()).toEqual({
      sent: 0,
      retried: 0,
      dead: 0,
      dropped: 0,
    });
  });
});
