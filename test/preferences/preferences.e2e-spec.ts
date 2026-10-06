import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { EmailTemplates } from '../../src/core/mail/email-templates';
import { emailPage } from '../../src/core/mail/layout';
import { Outbox } from '../../src/core/mail/outbox';
import {
  HELD_RETENTION_MS,
  OutboxProcessor,
} from '../../src/core/mail/outbox-processor';
import { localMinutes } from '../../src/core/preferences/zoned-time';
import { auditReaders } from '../setup/audit';
import { eraseNow } from '../setup/erasure';
import { communityHelpers, type Compound } from '../setup/community';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

const TWIN = 'test.preferences_twin';
const SOLE = 'test.preferences_sole';
const CRITICAL = 'test.preferences_critical';
const MINUTE = 60_000;

const hhmm = (minutes: number) => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * Delivery preferences (ADR 0036): the endpoints, and the outbox applying
 * them — held never dropped, skipped only when the email has an inbox twin,
 * critical always delivered, held mail decided again on every change.
 */
describe('Notification preferences', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let outbox: Outbox;
  let processor: OutboxProcessor;
  let globalDb: GlobalDbService;
  let tenantTx: TenantTx;
  let cls: ClsService<AppClsStore>;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    outbox = h.moduleRef.get(Outbox);
    processor = h.moduleRef.get(OutboxProcessor);
    globalDb = h.moduleRef.get(GlobalDbService);
    tenantTx = h.moduleRef.get(TenantTx);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    // Test templates for each delivery class (no real one has an inbox twin
    // and is not critical yet).
    const templates = h.moduleRef.get(EmailTemplates);
    const render = () => ({
      subject: 'Test',
      text: 'Test',
      html: emailPage('en', 'Test'),
    });
    templates.register(TWIN, render, {
      category: 'household',
      critical: false,
      soleRecord: false,
    });
    templates.register(SOLE, render, {
      category: 'household',
      critical: false,
      soleRecord: true,
    });
    templates.register(CRITICAL, render, {
      category: 'household',
      critical: true,
      soleRecord: false,
    });
    c = await x.compound('Preferences Court');
  });

  afterAll(() => h.close());

  async function someone() {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    return { ...p, token };
  }

  const patch = (token: string, body: object) =>
    h
      .http()
      .patch(`${API}/me/notification-preferences`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (token: string) =>
    h
      .http()
      .get(`${API}/me/notification-preferences`)
      .set('Authorization', `Bearer ${token}`);

  /** Queues a message to the account, as a domain would in its action. */
  function enqueue(accountId: string, templateKey: string, now = new Date()) {
    return cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      cls.set('accountId', accountId);
      cls.set('accountType', 'resident');
      return await tenantTx.withTenantTx((tx) =>
        outbox.enqueue(
          tx,
          {
            tenantId: c.tenantId,
            templateKey,
            locale: 'en',
            recipient: `${accountId}@example.test`,
            params: {},
            recipientAccountId: accountId,
          },
          now,
        ),
      );
    });
  }
  const row = (id: string) =>
    globalDb.outboxMessage.findUnique({ where: { id } });

  /** A quiet window around now in the compound's zone (Africa/Cairo). */
  const aroundNow = () => {
    const m = localMinutes(new Date(), 'Africa/Cairo');
    return { start: hhmm(m - 60), end: hhmm(m + 60) };
  };

  // --------------------------------------------------------------------------
  it('defaults: every switch on, no quiet hours, no pause', async () => {
    const p = await someone();
    const res = await get(p.token).expect(200);
    expect(Object.keys(res.body as object).sort()).toEqual([
      'categories',
      'pause',
      'quietHours',
      'timeZone',
    ]);
    expect(res.body).toEqual({
      categories: [
        'maintenance',
        'gate_visitors',
        'parcels',
        'household',
        'account_security',
      ].map((category) => ({ category, email: true, push: true })),
      quietHours: null,
      pause: null,
      timeZone: 'Africa/Cairo',
    });
  });

  it('changes only what is sent, and audits the change as codes', async () => {
    const p = await someone();
    await patch(p.token, {
      categories: [{ category: 'household', email: false }],
    }).expect(200);
    const res = await patch(p.token, {
      quietHours: { start: '22:00', end: '07:00' },
      pause: '1h',
    }).expect(200);
    const body = res.body as {
      categories: { category: string; email: boolean; push: boolean }[];
      quietHours: unknown;
      pause: { until: string };
    };
    expect(body.categories.find((x) => x.category === 'household')).toEqual({
      category: 'household',
      email: false,
      push: true,
    });
    expect(body.quietHours).toEqual({ start: '22:00', end: '07:00' });
    const until = new Date(body.pause.until).getTime();
    expect(Math.abs(until - (Date.now() + 60 * MINUTE))).toBeLessThan(MINUTE);

    // Turning the pause off; quiet hours stay.
    const off = await patch(p.token, { pause: null }).expect(200);
    expect(off.body).toMatchObject({
      pause: null,
      quietHours: { start: '22:00', end: '07:00' },
    });
    const indefinite = await patch(p.token, { pause: 'until_resumed' }).expect(
      200,
    );
    expect((indefinite.body as { pause: unknown }).pause).toEqual({
      until: null,
    });

    const rows = await auditReaders(h).tenant(c.tenantId, {
      action: 'notification_preferences.changed',
      targetId: p.id,
    });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      actorType: 'account',
      actorId: p.id,
      targetType: 'account',
      changes: { 'household.email': { from: true, to: false } },
      metadata: { assisted: false },
    });
    expect(rows[1].changes).toMatchObject({
      quietHours: { from: null, to: '22:00-07:00' },
    });
    expect(rows[3].changes).toMatchObject({
      pause: { from: null, to: 'until_resumed' },
    });
  });

  it('a request that changes nothing writes no audit row', async () => {
    const p = await someone();
    await patch(p.token, {
      categories: [{ category: 'parcels', email: true }],
    }).expect(200);
    expect(
      await auditReaders(h).tenant(c.tenantId, {
        action: 'notification_preferences.changed',
        targetId: p.id,
      }),
    ).toEqual([]);
  });

  it('refuses malformed preferences with field errors', async () => {
    const p = await someone();
    const fields = async (body: object) =>
      ((await patch(p.token, body).expect(400)).body as { fields: unknown })
        .fields;
    expect(
      await fields({ quietHours: { start: '22:00', end: '22:00' } }),
    ).toEqual([{ field: 'quietHours', code: 'INVALID_SCHEDULE' }]);
    expect(
      await fields({ quietHours: { start: '7:00', end: '25:00' } }),
    ).toEqual([
      { field: 'quietHours.start', code: 'INVALID_FORMAT' },
      { field: 'quietHours.end', code: 'INVALID_FORMAT' },
    ]);
    expect(
      await fields({
        categories: [
          { category: 'household', email: false },
          { category: 'household', push: false },
        ],
      }),
    ).toEqual([{ field: 'categories.1.category', code: 'DUPLICATE_VALUE' }]);
    expect(
      await fields({ categories: [{ category: 'marketing', email: false }] }),
    ).toEqual([
      {
        field: 'categories.0.category',
        code: 'INVALID_VALUE',
        params: {
          allowed: [
            'maintenance',
            'gate_visitors',
            'parcels',
            'household',
            'account_security',
          ],
        },
      },
    ]);
    expect(
      await fields({ categories: [{ category: 'household', sms: false }] }),
    ).toEqual([{ field: 'categories.0.sms', code: 'FIELD_NOT_ALLOWED' }]);
  });

  // --------------------------------------------------------------------------
  describe('the outbox', () => {
    it('defaults: written for now, not held', async () => {
      const p = await someone();
      const id = await enqueue(p.id, TWIN);
      expect(await row(id!)).toMatchObject({ status: 'pending', heldAt: null });
    });

    it('a category off skips an email with an inbox twin, never a sole record', async () => {
      const p = await someone();
      await patch(p.token, {
        categories: [{ category: 'household', email: false }],
      }).expect(200);
      expect(await enqueue(p.id, TWIN)).toBeNull();
      const sole = await enqueue(p.id, SOLE);
      expect(await row(sole!)).toMatchObject({
        status: 'pending',
        heldAt: null,
      });
      // Another category is untouched.
      await patch(p.token, {
        categories: [{ category: 'household', email: true }],
      }).expect(200);
      expect(await enqueue(p.id, TWIN)).not.toBeNull();
    });

    it('quiet hours hold until their end, in the compound’s time zone', async () => {
      const p = await someone();
      const window = aroundNow();
      await patch(p.token, { quietHours: window }).expect(200);
      const now = new Date();
      for (const key of [TWIN, SOLE]) {
        const m = (await row((await enqueue(p.id, key, now))!))!;
        expect(m.status).toBe('pending');
        expect(m.heldAt).toEqual(now);
        expect(m.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
        expect(m.nextAttemptAt.getTime()).toBeLessThanOrEqual(
          now.getTime() + 61 * MINUTE,
        );
        expect(hhmm(localMinutes(m.nextAttemptAt, 'Africa/Cairo'))).toBe(
          window.end,
        );
      }
      // Held, not due: the processor leaves it.
      const held = (await enqueue(p.id, TWIN, now))!;
      await processor.processDue(now);
      expect((await row(held))!.status).toBe('pending');
    });

    it('a critical email ignores quiet hours, a pause and a category off', async () => {
      const p = await someone();
      await patch(p.token, {
        categories: [{ category: 'household', email: false }],
        quietHours: aroundNow(),
        pause: 'until_resumed',
      }).expect(200);
      const id = await enqueue(p.id, CRITICAL);
      expect(await row(id!)).toMatchObject({ status: 'pending', heldAt: null });
    });

    it('a pause until resumed parks twins as held and lets sole records through', async () => {
      const p = await someone();
      await patch(p.token, { pause: 'until_resumed' }).expect(200);
      const twin = (await enqueue(p.id, TWIN))!;
      const sole = (await enqueue(p.id, SOLE))!;
      expect(await row(twin)).toMatchObject({ status: 'held' });
      expect((await row(twin))!.heldAt).not.toBeNull();
      expect(await row(sole)).toMatchObject({
        status: 'pending',
        heldAt: null,
      });

      // Never claimed while held.
      await processor.processDue(new Date(Date.now() + 365 * 86_400_000));
      expect(await row(twin)).toMatchObject({ status: 'held', attempts: 0 });

      // Turning the pause off releases it at once.
      const before = new Date();
      await patch(p.token, { pause: null }).expect(200);
      const released = (await row(twin))!;
      expect(released.status).toBe('pending');
      expect(released.heldAt).toBeNull();
      expect(released.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
    });

    it('a timed pause holds every non-critical email until it ends, then quiet hours', async () => {
      const p = await someone();
      await patch(p.token, { pause: '1h' }).expect(200);
      const now = new Date();
      for (const key of [TWIN, SOLE]) {
        const m = (await row((await enqueue(p.id, key, now))!))!;
        expect(m.status).toBe('pending');
        expect(
          Math.abs(m.nextAttemptAt.getTime() - (now.getTime() + 60 * MINUTE)),
        ).toBeLessThan(MINUTE);
      }
    });

    it('switching a category off while mail is held deletes the twins it held', async () => {
      const p = await someone();
      await patch(p.token, { pause: 'until_resumed' }).expect(200);
      const twin = (await enqueue(p.id, TWIN))!;
      const sole = (await enqueue(p.id, SOLE))!;
      await patch(p.token, {
        categories: [{ category: 'household', email: false }],
      }).expect(200);
      expect(await row(twin)).toBeNull();
      expect(await row(sole)).not.toBeNull();
    });

    it('the purge deletes twins held more than 7 days, never a sole record', async () => {
      const p = await someone();
      await patch(p.token, { pause: 'until_resumed' }).expect(200);
      const twin = (await enqueue(p.id, TWIN))!;
      const recent = (await enqueue(p.id, TWIN))!;
      // A sole record held by quiet hours a long time ago (as if stuck).
      const sole = (await enqueue(p.id, SOLE))!;
      const old = new Date(Date.now() - HELD_RETENTION_MS - MINUTE);
      await globalDb.outboxMessage.updateMany({
        where: { id: { in: [twin, sole] } },
        data: { heldAt: old },
      });
      await processor.purge(new Date());
      expect(await row(twin)).toBeNull();
      expect(await row(recent)).not.toBeNull();
      expect(await row(sole)).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  it('two changes at once lose neither (the settings row is locked)', async () => {
    for (let i = 0; i < 5; i++) {
      const p = await someone();
      const [a, b] = await Promise.all([
        patch(p.token, {
          categories: [{ category: 'household', email: false }],
        }),
        patch(p.token, { categories: [{ category: 'parcels', push: false }] }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const res = await get(p.token).expect(200);
      const cats = (
        res.body as {
          categories: { category: string; email: boolean; push: boolean }[];
        }
      ).categories;
      expect(cats.find((x) => x.category === 'household')!.email).toBe(false);
      expect(cats.find((x) => x.category === 'parcels')!.push).toBe(false);
      expect(
        await auditReaders(h).tenant(c.tenantId, {
          action: 'notification_preferences.changed',
          targetId: p.id,
        }),
      ).toHaveLength(2);
    }
  });

  it('erasure leaves nothing of the preferences', async () => {
    // Not a primary: erasure is refused for one (ADR 0036).
    const home = await x.unit(c);
    await x.resident(c, [home.id]);
    const tenant = await x.resident(c, [home.id], 'tenant');
    const p = {
      ...tenant,
      token: await h.tokenFor({
        sub: tenant.id,
        tid: c.tenantId,
        typ: 'resident',
      }),
    };
    await patch(p.token, {
      categories: [{ category: 'household', email: false }],
      quietHours: { start: '22:00', end: '07:00' },
    }).expect(200);
    await eraseNow(h, c, p.id);
    const left = await x.asManager(c, async () => ({
      settings: await x.prisma.tenant.notificationSettings.count({
        where: { accountId: p.id },
      }),
      switches: await x.prisma.tenant.notificationChannelPref.count({
        where: { accountId: p.id },
      }),
    }));
    expect(left).toEqual({ settings: 0, switches: 0 });
  });
});
