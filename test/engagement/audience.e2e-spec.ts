import { ResidentsService } from '../../src/community/residents/residents.service';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0040: an audience is a rule, read at each request against the
 * caller's places as they are then. This suite puts one person in every
 * capacity the rule tells apart and checks, for every audience, that the
 * feed and the single read agree with it and with each other; then that a
 * newcomer sees what is live and someone who left sees nothing.
 */
describe('Community life — audiences are evaluated at read time', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  /** Building A: an owner's home, with a family member. */
  let ownerA: Who;
  let familyA: Who;
  /** Building B: a rented unit, its landlord, its tenant and the tenant's family. */
  let landlordB: Who;
  let tenantB: Who;
  let familyB: Who;
  /** A unit in no building, lived in by its owner. */
  let ownerNowhere: Who;
  let everyone: Record<string, Who>;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    ownerA = s.owner;
    familyA = await e.family(s.c, s.home.id, ownerA);
    const rented = await e.unit(s.c, 'B');
    landlordB = await e.landlord(s.c, rented.id);
    tenantB = await e.tenant(s.c, rented.id);
    familyB = await e.family(s.c, rented.id, tenantB);
    ownerNowhere = await e.owner(s.c, (await e.unit(s.c, null)).id);
    everyone = { ownerA, familyA, landlordB, tenantB, familyB, ownerNowhere };
  }, 180_000);

  afterAll(() => h.close());

  /** Who, of the six, gets the announcement: in the feed and by its id. */
  async function readers(id: string) {
    const out: string[] = [];
    for (const [name, who] of Object.entries(everyone)) {
      const feed = (
        (await e.http('get', '/announcements?limit=100', who.token).expect(200))
          .body as { data: { id: string }[] }
      ).data.some((a) => a.id === id);
      const one = await e.http('get', `/announcements/${id}`, who.token);
      // The list and the single read never disagree.
      expect({ name, one: one.status }).toEqual({
        name,
        one: feed ? 200 : 404,
      });
      if (!feed)
        expect((one.body as { code: string }).code).toBe(
          'ANNOUNCEMENT_NOT_FOUND',
        );
      if (feed) out.push(name);
    }
    return out.sort();
  }

  const ALL = [
    'familyA',
    'familyB',
    'landlordB',
    'ownerA',
    'ownerNowhere',
    'tenantB',
  ];

  it.each([
    ['the whole compound, everyone', undefined, ALL],
    [
      'owners: every owner, landlords included, and nobody else',
      { occupancy: 'owners' },
      ['landlordB', 'ownerA', 'ownerNowhere'],
    ],
    [
      'tenants: the tenants and the members of a rented unit’s household',
      { occupancy: 'tenants' },
      ['familyB', 'tenantB'],
    ],
    [
      'building A: everyone in it, and not the unit without a building',
      { occupancy: 'everyone', buildings: ['A'] },
      ['familyA', 'ownerA'],
    ],
    [
      'buildings A and B, owners',
      { occupancy: 'owners', buildings: ['A', 'B'] },
      ['landlordB', 'ownerA'],
    ],
    [
      'building A, tenants: nobody',
      { occupancy: 'tenants', buildings: ['A'] },
      [],
    ],
  ] as const)('%s', async (_, audience, expected) => {
    const id = await e.announcement(s.manager, audience ? { audience } : {});
    expect(await readers(id)).toEqual([...expected]);
  });

  it('the same rule puts events and polls to the same people', async () => {
    const audience = { occupancy: 'tenants' };
    const eventId = await e.event(s.manager, { audience });
    const pollId = await e.poll(s.manager, { audience });
    for (const [name, who] of Object.entries(everyone)) {
      const in_ = ['tenantB', 'familyB'].includes(name);
      for (const path of [`/events/${eventId}`, `/polls/${pollId}`])
        expect({
          name,
          path,
          status: (await e.http('get', path, who.token)).status,
        }).toEqual({ name, path, status: in_ ? 200 : 404 });
    }
  });

  it('a building must be one the compound’s units name; the preview counts units and accounts now', async () => {
    expect(
      (await e.http('get', '/community/buildings', s.manager.token).expect(200))
        .body,
    ).toEqual({ buildings: ['A', 'B'] });
    const unknown = await e
      .http('post', '/community/announcements', s.manager.token, {
        kind: 'general',
        titleEn: 'x',
        bodyEn: 'y',
        audience: { occupancy: 'everyone', buildings: ['A', 'Z'] },
      })
      .expect(400);
    expect((unknown.body as { fields: unknown[] }).fields).toEqual([
      { field: 'audience.buildings.1', code: 'INVALID_VALUE' },
    ]);
    const size = async (audience: object) =>
      (
        await e
          .http('post', '/community/audience/preview', s.manager.token, {
            audience,
          })
          .expect(200)
      ).body as { units: number; accounts: number };
    expect(await size({ occupancy: 'everyone' })).toEqual({
      units: 3,
      accounts: 6,
    });
    expect(await size({ occupancy: 'owners' })).toEqual({
      units: 3,
      accounts: 3,
    });
    expect(await size({ occupancy: 'tenants', buildings: ['B'] })).toEqual({
      units: 1,
      accounts: 2,
    });
  });

  describe('newcomers and leavers', () => {
    it('someone who arrives after an announcement came out sees it; they were not told', async () => {
      const id = await e.announcement(s.manager, { priority: 'important' });
      const unit = await e.unit(s.c, 'A');
      const newcomer = await e.owner(s.c, unit.id);
      await e.http('get', `/announcements/${id}`, newcomer.token).expect(200);
      expect(
        await e.notifications(
          s.c,
          newcomer.id,
          'community_announcement.important',
        ),
      ).toEqual([]);
      // Those who were there were.
      expect(
        await e.notifications(
          s.c,
          ownerA.id,
          'community_announcement.important',
        ),
      ).not.toEqual([]);
    });

    it('someone whose occupancy ended sees nothing, in any list or by id', async () => {
      const unit = await e.unit(s.c, 'A');
      const leaver = await e.tenant(s.c, unit.id);
      const announcementId = await e.announcement(s.manager);
      const eventId = await e.event(s.manager);
      const pollId = await e.poll(s.manager);
      await e
        .http('get', `/announcements/${announcementId}`, leaver.token)
        .expect(200);

      const [occupancy] = await e.x.occupancies(s.c, unit.id);
      await e.x.asManager(s.c, () =>
        h.moduleRef
          .get(ResidentsService)
          .endOccupancy(occupancy.id, { code: 'moved_out' }),
      );

      for (const path of ['/announcements', '/events', '/polls'])
        expect(
          (
            (await e.http('get', path, leaver.token).expect(200)).body as {
              data: unknown[];
            }
          ).data,
        ).toEqual([]);
      for (const path of [
        `/announcements/${announcementId}`,
        `/events/${eventId}`,
        `/polls/${pollId}`,
      ])
        await e.http('get', path, leaver.token).expect(404);
      const brief = (
        await e.http('get', '/me/daily-brief', leaver.token).expect(200)
      ).body as {
        works: unknown[];
        events: unknown[];
        announcements: { pinned: unknown[]; new: unknown[] };
        polls: unknown[];
      };
      expect([
        brief.works,
        brief.events,
        brief.announcements.pinned,
        brief.announcements.new,
        brief.polls,
      ]).toEqual([[], [], [], [], []]);
    });
  });
});
