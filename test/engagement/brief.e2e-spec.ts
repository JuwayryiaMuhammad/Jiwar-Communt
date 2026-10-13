import { gateHelpers } from '../setup/gate';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Brief {
  date: string;
  timeZone: string;
  works: { id: string }[];
  events: { id: string }[];
  announcements: { pinned: { id: string }[]; new: { id: string }[] };
  polls: { id: string; pendingUnitIds: string[] }[];
  tickets: {
    open: number;
    latest: { id: string; number: string; status: string } | null;
  } | null;
  requests: {
    open: number;
    latest: { id: string; number: string; status: string } | null;
  } | null;
  gates: { id: string; name: string; open: boolean }[];
}

/**
 * ADR 0040: the daily brief — computed when asked, for the caller, from
 * what is true at that moment; stored nowhere.
 */
describe('Community life — the daily brief', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
  }, 60_000);

  afterAll(() => h.close());

  const brief = async (who: Who) =>
    (await e.http('get', '/me/daily-brief', who.token).expect(200))
      .body as Brief;
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it('an empty compound: the day in its time zone, empty lists, zero counts', async () => {
    const view = await brief(s.owner);
    expect(view).toMatchObject({
      timeZone: 'Africa/Cairo',
      works: [],
      events: [],
      announcements: { pinned: [], new: [] },
      polls: [],
      tickets: { open: 0, latest: null },
      requests: { open: 0, latest: null },
      gates: [],
    });
    expect(view.date).toBe(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(
        new Date(),
      ),
    );
  });

  it('works under way are in it; works that have not started or have ended are not', async () => {
    const active = await e.works(s.manager);
    const upcoming = await e.works(s.manager, {
      works: { startsAt: e.at(5), endsAt: e.at(6), areaKind: 'road' },
    });
    const over = await e.works(s.manager);
    await e.x.asManager(s.c, () =>
      e.x.prisma.tenant.announcement.update({
        where: { id: over },
        data: {
          publishAt: e.at(-5),
          worksStartsAt: e.at(-3),
          worksEndsAt: e.at(-1),
        },
      }),
    );
    const view = await brief(s.owner);
    expect(ids(view.works)).toContain(active);
    expect(ids(view.works)).not.toContain(upcoming);
    expect(ids(view.works)).not.toContain(over);
    // Works are not "new announcements" as well.
    expect(ids(view.announcements.new)).not.toContain(active);
  });

  it('announcements: pinned ones on top; new ones until the caller opens them, for seven days', async () => {
    const pinned = await e.announcement(s.manager, {
      priority: 'important',
      pinnedUntil: e.at(24),
    });
    const fresh = await e.announcement(s.manager);
    const old = await e.announcement(s.manager);
    await e.x.asManager(s.c, () =>
      e.x.prisma.tenant.announcement.update({
        where: { id: old },
        data: { publishAt: e.at(-8 * 24) },
      }),
    );
    let view = await brief(s.owner);
    expect(ids(view.announcements.pinned)).toEqual([pinned]);
    expect(ids(view.announcements.new)).toContain(fresh);
    expect(ids(view.announcements.new)).not.toContain(old);
    expect(ids(view.announcements.new)).not.toContain(pinned);

    await e
      .http('post', `/announcements/${fresh}/read`, s.owner.token)
      .expect(204);
    await e
      .http('post', `/announcements/${pinned}/read`, s.owner.token)
      .expect(204);
    view = await brief(s.owner);
    expect(ids(view.announcements.new)).not.toContain(fresh);
    // A pin holds whether or not it was opened.
    expect(ids(view.announcements.pinned)).toEqual([pinned]);
    // Someone else has not opened it: still new for them.
    const neighbour = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
    expect(ids((await brief(neighbour)).announcements.new)).toContain(fresh);
  });

  it('today’s events that are not over, and not cancelled; tomorrow’s are not today’s', async () => {
    const zone = 'Africa/Cairo';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(
      new Date(),
    );
    const localDay = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(d);
    const soon = await e.event(s.manager, {
      startsAt: e.at(0.02),
      endsAt: e.at(0.05),
    });
    const tomorrow = await e.event(s.manager, {
      startsAt: e.at(26),
      endsAt: e.at(27),
    });
    const cancelled = await e.event(s.manager, {
      startsAt: e.at(0.02),
      endsAt: e.at(0.05),
    });
    await e
      .http('post', `/community/events/${cancelled}/cancel`, s.manager.token, {
        reasonCode: 'weather',
      })
      .expect(204);
    const view = await brief(s.owner);
    // Three minutes from now is still today, unless the day is about to turn.
    if (localDay(e.at(0.02)) === today)
      expect(ids(view.events)).toContain(soon);
    expect(ids(view.events)).not.toContain(cancelled);
    if (localDay(e.at(26)) !== today)
      expect(ids(view.events)).not.toContain(tomorrow);
  });

  it('polls closing within 48 hours that wait for a vote the caller casts; gone once the unit voted', async () => {
    const member = await e.family(s.c, s.home.id, s.owner);
    const closing = await e.poll(s.manager, { closesAt: e.at(24) });
    const later = await e.poll(s.manager, { closesAt: e.at(72) });
    let view = await brief(s.owner);
    expect(view.polls.find((p) => p.id === closing)).toMatchObject({
      pendingUnitIds: [s.home.id],
    });
    expect(ids(view.polls)).not.toContain(later);
    // A member who does not cast the vote has nothing pending.
    expect(ids((await brief(member)).polls)).not.toContain(closing);

    const [yes] = await e.optionIds(s.manager, closing);
    await e.vote(s.owner, closing, [yes]).expect(201);
    view = await brief(s.owner);
    expect(ids(view.polls)).not.toContain(closing);
  });

  it('the caller’s open tickets and management requests: a count and the latest one’s status', async () => {
    const neighbour = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
    const category = await e.x.asManager(s.c, () =>
      e.x.prisma.tenant.ticketCategory.findFirstOrThrow({
        where: { key: 'plumbing' },
      }),
    );
    const ticket = (
      await e
        .http('post', '/tickets', s.owner.token, {
          unitId: s.home.id,
          categoryId: category.id,
          description: 'A leak under the sink',
        })
        .expect(201)
    ).body as { id: string; number: string };
    const first = await e.open(s.c, s.owner);
    const second = await e.open(s.c, s.owner);
    await e
      .http('post', `/management/requests/${first.id}/close`, s.manager.token, {
        reasonCode: 'resolved',
      })
      .expect(204);

    const view = await brief(s.owner);
    expect(view.tickets).toEqual({
      open: 1,
      latest: { id: ticket.id, number: ticket.number, status: 'new' },
    });
    expect(view.requests).toEqual({
      open: 1,
      latest: { id: second.id, number: second.number, status: 'open' },
    });
    // Each caller's own: a neighbour has none of it.
    expect(await brief(neighbour)).toMatchObject({
      tickets: { open: 0, latest: null },
      requests: { open: 0, latest: null },
    });
  });

  it('the gates and whether each is in service; never who is on duty', async () => {
    const gate = await gateHelpers(h).gate(s.c, 'North gate');
    const duty = await gateHelpers(h).onDuty(s.c);
    const view = await brief(s.owner);
    expect(view.gates).toEqual(
      [
        { id: gate.id, name: 'North gate', open: true },
        { id: duty.gateId, name: duty.gateName, open: true },
      ].sort((a, b) => a.name.localeCompare(b.name)),
    );
    expect(JSON.stringify(view)).not.toContain(duty.guardId);
  });

  it('nothing is stored: asking twice writes no row anywhere of the community life', async () => {
    const counts = () =>
      e.inTx(
        s.c,
        (tx) =>
          tx.$queryRaw<{ n: bigint }[]>`
          SELECT (SELECT count(*) FROM announcement_read_marks)
               + (SELECT count(*) FROM audit_log)
               + (SELECT count(*) FROM notifications) AS n`,
      );
    const before = await counts();
    await brief(s.owner);
    await brief(s.owner);
    expect(await counts()).toEqual(before);
  });

  it('it is the residents’: the staff have no brief', async () => {
    await e.http('get', '/me/daily-brief', s.manager.token).expect(403);
    const publisher = await e.staff(s.c, ['community.publish']);
    await e.http('get', '/me/daily-brief', publisher.token).expect(403);
  });
});
