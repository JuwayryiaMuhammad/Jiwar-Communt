import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import {
  BRIEFS_EVERY_MS,
  BRIEFS_SWEEP,
  StaffBriefsService,
} from '../../src/core/staff-dashboard/staff-briefs.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import { clock, clockAt, day, dbDate } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

interface Brief {
  id: string;
  kind: 'brief' | 'review';
  date: string;
  generatedAt: string;
  timeZone: string;
  figures: Record<string, Record<string, unknown> | null>;
  inbox: { total: number; overdue: number; types: { type: string }[] } | null;
}

const READY = ['staff_brief.ready', 'staff_review.ready'];

/**
 * ADR 0079: the daily brief and the end-of-day review. Written once per
 * compound, kind and local day, once the compound's clock passed its time
 * (07:00 and 17:00 by default, a setting); never a day late, never in a
 * suspended compound. Only the writer tells the dashboard.read holders: two
 * sweeps at once write one and tell once. Read back by each reader's
 * sections and inbox types. The suites run the compound's own pass, so no
 * other compound's managers are told.
 */
describe('Operations dashboard — the daily brief and the end-of-day review', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let other: SetUp;
  let accountant: Who;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    other = await d.setUp(1);
    accountant = await d.who(
      s.c,
      (await d.g.guard(s.c, 'accountant')).id,
      'staff',
    );
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const briefs = () => h.moduleRef.get(StaffBriefsService);

  /** The compound's own pass of the sweep, as of `now`. */
  const run = (now: Date, c: SetUp = s) =>
    d.inTenant(c.c, (tx) => briefs().runIn(tx, c.c.tenantId, now));

  const rows = (date: string, c: SetUp = s) =>
    d.inTenant(c.c, (tx) =>
      tx.staffBrief.findMany({
        where: { day: dbDate(date) },
        orderBy: { kind: 'asc' },
      }),
    );

  const told = (targetId: string, c: SetUp = s) =>
    d.inTenant(c.c, (tx) =>
      tx.notification.findMany({
        where: { targetId, kind: { in: READY } },
        select: { accountId: true, kind: true, params: true },
      }),
    );

  const brief = async (id: string, who: Who = s.manager) =>
    (await d.http('get', `/staff/briefs/${id}`, who.token).expect(200))
      .body as Brief;

  it('runs every five minutes', () => {
    expect(h.moduleRef.get(SweepRunner).intervalOf(BRIEFS_SWEEP)).toBe(
      BRIEFS_EVERY_MS,
    );
  });

  it('nothing before 07:00; at 07:00 the brief, once; the dashboard.read holders told, never a technician', async () => {
    const date = day(1);
    expect(await run(clock().at(date, 6, 59))).toBe(0);
    expect(await rows(date)).toEqual([]);
    expect(await run(clock().at(date, 7, 0))).toBe(1);
    expect(await run(clock().at(date, 7, 5))).toBe(0);
    const [b] = await rows(date);
    expect(b).toMatchObject({ kind: 'brief' });
    const notices = await told(b.id);
    expect(notices.map((n) => n.accountId).sort()).toEqual(
      [s.manager.id, s.supervisor.id, accountant.id].sort(),
    );
    expect(notices.every((n) => n.kind === 'staff_brief.ready')).toBe(true);
    expect(notices[0].params).toEqual({ date });
  });

  it('at 17:00 the review; each of the day’s two once', async () => {
    const date = day(1);
    expect(await run(clock().at(date, 17, 0))).toBe(1);
    expect(await run(clock().at(date, 23, 55))).toBe(0);
    expect((await rows(date)).map((r) => r.kind)).toEqual(['brief', 'review']);
    const review = (await rows(date)).find((r) => r.kind === 'review')!;
    expect((await told(review.id)).map((n) => n.kind)).toContain(
      'staff_review.ready',
    );
  });

  it('two sweeps at once write one brief and tell each holder once', async () => {
    const date = day(2);
    const now = clock().at(date, 8, 0);
    const done = await Promise.all([run(now), run(now), run(now)]);
    expect(done.reduce((a, b) => a + b, 0)).toBe(1);
    const written = await rows(date);
    expect(written.map((r) => r.kind)).toEqual(['brief']);
    const notices = await told(written[0].id);
    expect(notices.filter((n) => n.accountId === s.manager.id)).toHaveLength(1);
  });

  it('never a day late: past midnight, the day before is not written', async () => {
    const date = day(3);
    expect(await run(clock().at(day(4), 1, 0))).toBe(0);
    expect(await rows(date)).toEqual([]);
    expect(await rows(day(4))).toEqual([]);
  });

  it('the figures as of its time, on its day: today’s tickets are not the next day’s', async () => {
    await d.openTicket(s);
    const date = day(6);
    await run(clock().at(date, 17, 30));
    const written = await rows(date);
    expect(written.map((r) => r.kind)).toEqual(['brief', 'review']);
    const review = await brief(written.find((r) => r.kind === 'review')!.id);
    expect(review.date).toBe(date);
    expect(review.figures.maintenance).toMatchObject({ openedToday: 0 });
    expect(
      (review.figures.maintenance as { open: number }).open,
    ).toBeGreaterThanOrEqual(1);
  });

  it('is read back by the reader’s sections and inbox types', async () => {
    const [b] = await rows(day(1));
    const all = await brief(b.id);
    for (const section of [
      'units',
      'maintenance',
      'energy',
      'security',
      'gate',
      'finance',
    ])
      expect(all.figures[section]).not.toBeNull();
    const theirs = await brief(b.id, accountant);
    expect(
      Object.entries(theirs.figures)
        .filter(([, f]) => f !== null)
        .map(([k]) => k),
    ).toEqual(['finance']);
    expect(theirs.inbox!.types.map((t) => t.type)).not.toContain('vehicle');
    expect(all.inbox!.types.map((t) => t.type)).toContain('vehicle');

    const list = (
      await d
        .http('get', '/staff/briefs?kind=brief', s.manager.token)
        .expect(200)
    ).body as { data: { id: string; kind: string; date: string }[] };
    expect(list.data.map((r) => r.id)).toContain(b.id);
    expect(list.data.every((r) => r.kind === 'brief')).toBe(true);

    await d.http('get', `/staff/briefs/${b.id}`, s.techs[0].token).expect(403);
  });

  it('another compound’s brief, or none, is not found', async () => {
    const date = day(1);
    await run(clock().at(date, 7, 30), other);
    const [theirs] = await rows(date, other);
    for (const id of [theirs.id, newId()]) {
      const res = await d
        .http('get', `/staff/briefs/${id}`, s.manager.token)
        .expect(404);
      expect((res.body as { code: string }).code).toBe('STAFF_BRIEF_NOT_FOUND');
    }
    // Their pass told their holders only.
    expect(
      (await told(theirs.id, other)).map((n) => n.accountId),
    ).not.toContain(s.manager.id);
  });

  it('the settings: 07:00 and 17:00 by default; the review after the brief; null turns one off; audited', async () => {
    const get = await d
      .http('get', '/staff/dashboard/settings', s.supervisor.token)
      .expect(200);
    expect(get.body).toEqual({
      briefAt: '07:00',
      reviewAt: '17:00',
      timeZone: 'Africa/Cairo',
    });
    const before = await d
      .http('patch', '/staff/dashboard/settings', s.manager.token, {
        reviewAt: '06:30',
      })
      .expect(400);
    expect((before.body as { fields: unknown[] }).fields).toEqual([
      { field: 'reviewAt', code: 'ENDS_BEFORE_START' },
    ]);
    const shape = await d
      .http('patch', '/staff/dashboard/settings', s.manager.token, {
        briefAt: '7:00',
      })
      .expect(400);
    expect((shape.body as { fields: unknown[] }).fields).toEqual([
      { field: 'briefAt', code: 'INVALID_FORMAT' },
    ]);
    await d
      .http('patch', '/staff/dashboard/settings', s.supervisor.token, {
        briefAt: null,
      })
      .expect(403);

    const off = await d
      .http('patch', '/staff/dashboard/settings', s.manager.token, {
        briefAt: null,
        reviewAt: '18:15',
      })
      .expect(200);
    expect(off.body).toEqual({
      briefAt: null,
      reviewAt: '18:15',
      timeZone: 'Africa/Cairo',
    });
    const date = day(8);
    expect(await run(clock().at(date, 18, 0))).toBe(0);
    expect(await run(clock().at(date, 18, 15))).toBe(1);
    expect((await rows(date)).map((r) => r.kind)).toEqual(['review']);

    const audit = await read.tenant(s.c.tenantId, {
      action: 'staff_dashboard.settings_changed',
    });
    expect(audit.at(-1)!.changes).toEqual({
      briefAt: { from: '07:00', to: null },
      reviewAt: { from: '17:00', to: '18:15' },
    });
    await d
      .http('patch', '/staff/dashboard/settings', s.manager.token, {
        briefAt: '07:00',
        reviewAt: '17:00',
      })
      .expect(200);
  });

  it('the compound’s day in its own time zone', async () => {
    const zone = 'Pacific/Kiritimati';
    await d.inTenant(s.c, (tx) =>
      tx.tenantSettings.update({
        where: { tenantId: s.c.tenantId },
        data: { timezone: zone },
      }),
    );
    try {
      // 07:30 there is the evening before in Cairo.
      const date = clock(zone).day(10);
      const now = clock(zone).at(date, 7, 30);
      expect(clockAt(now).today).not.toBe(date);
      expect(await run(now)).toBe(1);
      const [b] = await rows(date);
      expect(b.kind).toBe('brief');
      expect((await brief(b.id)).timeZone).toBe(zone);
    } finally {
      await d.inTenant(s.c, (tx) =>
        tx.tenantSettings.update({
          where: { tenantId: s.c.tenantId },
          data: { timezone: 'Africa/Cairo' },
        }),
      );
    }
  });

  it('not in a suspended compound', async () => {
    const globalDb = h.moduleRef.get(GlobalDbService);
    await globalDb.tenant.update({
      where: { id: other.c.tenantId },
      data: { status: 'suspended' },
    });
    try {
      expect(await run(clock().at(day(12), 9, 0), other)).toBe(0);
      expect(await rows(day(12), other)).toEqual([]);
    } finally {
      await globalDb.tenant.update({
        where: { id: other.c.tenantId },
        data: { status: 'active' },
      });
    }
  });
});
