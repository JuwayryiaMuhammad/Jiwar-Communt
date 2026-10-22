import { clock } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  ALWAYS,
  partnersHelpers,
  rewindListing,
  type PartnersSetUp,
} from '../setup/partners';

/**
 * How residents find partners (ADR 0060): by category and sub-category,
 * open now and open late tonight on the compound's clock, new ones, and
 * their own favourites, which nobody else sees.
 */
describe('Partners: discovery and favourites (ADR 0060)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
  }, 180_000);

  afterAll(() => h.close());

  const ids = (list: { id: string }[]) => list.map((x) => x.id);

  it('residents see what the partner says of itself, never the staff’s email or a suspension’s reason', async () => {
    const id = await p.partner(s.c, s.keeper, {
      notifyEmail: 'desk@example.com',
    });
    const body = (await p.get(s.alice, id).expect(200)).body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ id, businessPhone: '+20225550100' });
    for (const key of [
      'notifyEmail',
      'status',
      'suspendedReason',
      'suspendedAt',
      'createdById',
    ])
      expect(body).not.toHaveProperty(key);
    expect(body.timeZone).toBe('Africa/Cairo');
  });

  it('by category and by sub-category', async () => {
    const vet = await p.partner(s.c, s.keeper, {
      services: [
        {
          category: 'pets',
          subcategoryId: await p.subcategory(s.c, 'vet_visits'),
        },
      ],
    });
    const groomer = await p.partner(s.c, s.keeper, {
      services: [{ category: 'pets' }],
    });
    expect(ids(await p.listed(s.alice, { category: 'pets' })).sort()).toEqual(
      [vet, groomer].sort(),
    );
    expect(
      ids(
        await p.listed(s.alice, {
          subcategoryId: await p.subcategory(s.c, 'vet_visits'),
        }),
      ),
    ).toEqual([vet]);
  });

  it('open now: a window of today holds this minute; a partner closed today is not', async () => {
    const open = await p.partner(s.c, s.keeper, {}, p.openNowHours());
    const closed = await p.partner(s.c, s.keeper, {}, p.closedTodayHours());
    const never = await p.partner(s.c, s.keeper, {}, []);
    const listed = await p.listed(s.alice, { openNow: 'true' });
    expect(ids(listed)).toContain(open);
    expect(ids(listed)).not.toContain(closed);
    expect(ids(listed)).not.toContain(never);
    const one = (await p.get(s.alice, closed).expect(200)).body as {
      openNow: boolean;
    };
    expect(one.openNow).toBe(false);
  });

  it('open late tonight: still open after the compound’s late hour today; closing at it is not late', async () => {
    const today = clock().weekday();
    const late = await p.partner(s.c, s.keeper, {}, [
      { weekday: today, startMinute: 0, endMinute: 1440 },
    ]);
    const shut = await p.partner(s.c, s.keeper, {}, [
      { weekday: today, startMinute: 0, endMinute: 1320 },
    ]);
    const listed = ids(await p.listed(s.alice, { openLate: 'true' }));
    expect(listed).toContain(late);
    expect(listed).not.toContain(shut);
    // The late hour is the compound's.
    await p
      .http('patch', '/staff/partner-settings', s.manager.token, {
        lateFromMinute: 1439,
      })
      .expect(200);
    try {
      expect(ids(await p.listed(s.alice, { openLate: 'true' }))).toContain(
        late,
      );
    } finally {
      await p
        .http('patch', '/staff/partner-settings', s.manager.token, {
          lateFromMinute: 1320,
        })
        .expect(200);
    }
  });

  it('new: listed within the compound’s new days', async () => {
    const fresh = await p.partner(s.c, s.keeper);
    const old = await p.partner(s.c, s.keeper);
    // Listed 40 days ago: past the compound's 30 new days.
    await rewindListing(old, 40);
    const listed = ids(await p.listed(s.alice, { new: 'true' }));
    expect(listed).toContain(fresh);
    expect(listed).not.toContain(old);
  });

  describe('favourites', () => {
    it('are the caller’s own: kept once, listed, taken off; nobody else sees them', async () => {
      const id = await p.partner(s.c, s.keeper, {}, ALWAYS);
      await p
        .http('put', `/partners/${id}/favourite`, s.alice.token)
        .expect(204);
      await p
        .http('put', `/partners/${id}/favourite`, s.alice.token)
        .expect(204);
      expect(ids(await p.listed(s.alice, { favourites: 'true' }))).toEqual([
        id,
      ]);
      expect(await p.listed(s.bob, { favourites: 'true' })).toEqual([]);
      expect(
        ((await p.get(s.bob, id).expect(200)).body as { favourite: boolean })
          .favourite,
      ).toBe(false);
      await p
        .http('delete', `/partners/${id}/favourite`, s.alice.token)
        .expect(204);
      await p
        .http('delete', `/partners/${id}/favourite`, s.alice.token)
        .expect(204);
      expect(await p.listed(s.alice, { favourites: 'true' })).toEqual([]);
    });

    it('at most fifty, even asked at once: the count and the insert are one step under the account’s lock', async () => {
      const carol = await p.owner(s.c, s.homeA.id);
      const fresh: string[] = [];
      for (let i = 0; i < 51; i++) fresh.push(await p.partner(s.c, s.keeper));
      for (const id of fresh.slice(0, 49))
        await p
          .http('put', `/partners/${id}/favourite`, carol.token)
          .expect(204);
      const [x, y] = await Promise.all(
        fresh
          .slice(49, 51)
          .map((id) => p.http('put', `/partners/${id}/favourite`, carol.token)),
      );
      expect([x.status, y.status].sort()).toEqual([204, 409]);
      expect([x, y].find((r) => r.status === 409)!.body).toMatchObject({
        code: 'PARTNER_FAVOURITES_LIMIT_REACHED',
        params: { max: 50 },
      });
      expect(
        await p.inTx(s.c, (tx) =>
          tx.partnerFavourite.count({ where: { accountId: carol.id } }),
        ),
      ).toBe(50);
    });
  });
});
