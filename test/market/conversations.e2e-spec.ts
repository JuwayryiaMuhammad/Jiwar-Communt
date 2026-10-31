import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp, type Who } from '../setup/market';

/**
 * ADR 0071: a buyer writes to a seller through the neighbours' masked
 * conversation — each a building to the other, names only when both agree;
 * blocks, reports and the staff queue are the neighbours' own.
 */
describe('Market — conversations with a seller', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;
  let carol: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
    carol = await m.owner(s.c, (await m.unit(s.c, 'C')).id);
    await m.settings(s.c, s.manager, { maxNewConversationsPerDay: 100 });
  }, 180_000);

  afterAll(() => h.close());

  const contact = (by: Who, listingId: string, body = 'Still for sale?') =>
    m.http('post', `/market/listings/${listingId}/conversations`, by.token, {
      body,
    });

  it('a buyer writes about a live listing; both read it as a building, the seller is told by the listing’s kind', async () => {
    const listing = await m.live(s.alice, s.marketHandler, {
      title: 'Rowing machine',
    });
    const res = await contact(s.bob, listing).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const id = (res.body as { id: string }).id;
    expect(
      (
        await m
          .http('get', `/neighbour-conversations/${id}`, s.alice.token)
          .expect(200)
      ).body,
    ).toMatchObject({
      post: null,
      listing: { id: listing, kind: 'sell', state: 'live' },
      side: 'author',
      open: true,
      other: { building: 'B', firstName: null },
    });
    expect(
      (
        await m
          .http('get', `/neighbour-conversations/${id}`, s.bob.token)
          .expect(200)
      ).body,
    ).toMatchObject({ side: 'responder', other: { building: 'A' } });
    expect(
      (await m.notifications(s.c, s.alice.id, 'neighbour_conversation.started'))
        .filter((n) => n.targetId === id)
        .map((n) => n.params),
    ).toEqual([{ listingKind: 'sell' }]);
    // Once a listing and responder.
    const again = await contact(s.bob, listing).expect(409);
    expect(again.body).toMatchObject({
      code: 'NEIGHBOUR_CONVERSATION_EXISTS',
      params: { conversationId: id },
    });
  });

  it('nobody writes about their own listing, nor about one waiting for review', async () => {
    const live = await m.live(s.alice, s.marketHandler, { title: 'My own' });
    expect((await contact(s.alice, live).expect(409)).body).toMatchObject({
      code: 'MARKET_LISTING_NO_CONTACT',
    });
    const waiting = await m.listing(s.alice, { title: 'Waiting one' });
    await contact(s.bob, waiting.id).expect(404);
  });

  it('a conversation closes for writing when its listing leaves the market', async () => {
    const listing = await m.live(s.alice, s.marketHandler, {
      title: 'Bookshelf',
    });
    const id = (
      (await contact(carol, listing).expect(201)).body as { id: string }
    ).id;
    await m
      .http('post', `/market/listings/${listing}/sold`, s.alice.token)
      .expect(204);
    await m
      .http('post', `/neighbour-conversations/${id}/messages`, carol.token, {
        body: 'Too late?',
      })
      .expect(409);
    expect(
      (
        await m
          .http('get', `/neighbour-conversations/${id}`, carol.token)
          .expect(200)
      ).body,
    ).toMatchObject({ open: false, listing: { state: 'sold' } });
  });

  it('a block reads as a listing not there', async () => {
    const listing = await m.live(s.bob, s.marketHandler, { title: 'Scooter' });
    const id = (
      (await contact(carol, listing).expect(201)).body as { id: string }
    ).id;
    await m
      .http('post', `/neighbour-conversations/${id}/block`, s.bob.token)
      .expect(204);
    const other = await m.live(s.bob, s.marketHandler, { title: 'Helmet' });
    expect((await contact(carol, other).expect(404)).body).toMatchObject({
      code: 'MARKET_LISTING_NOT_FOUND',
    });
  });

  it('a report closed `post_removed` takes the listing off the market', async () => {
    const listing = await m.live(s.alice, s.marketHandler, { title: 'Sofa' });
    const id = (
      (await contact(carol, listing).expect(201)).body as { id: string }
    ).id;
    const report = (
      (
        await m
          .http(
            'post',
            `/neighbour-conversations/${id}/report`,
            s.alice.token,
            {
              reasonCode: 'harassment',
            },
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    await m
      .http('post', `/neighbours/reports/${report}/close`, s.handler.token, {
        reasonCode: 'post_removed',
      })
      .expect(204);
    expect(await m.row(s.c, listing)).toMatchObject({
      status: 'removed',
      reasonCode: 'harassment',
    });
  });

  it('race: a removal and a conversation starting at once — a conversation exists only on a listing that was live when it began (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const listing = await m.live(s.alice, s.marketHandler, {
        title: `Race lamp ${round}`,
      });
      const [started, removed] = await Promise.all([
        contact(s.bob, listing),
        m.review(s.marketHandler, listing, 'remove', 'scam'),
      ]);
      expect(removed.status).toBe(204);
      expect([201, 404]).toContain(started.status);
      const row = await m.row(s.c, listing);
      expect(row.status).toBe('removed');
      const conversations = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.neighbourConversation.findMany({
          where: { listingId: listing },
        }),
      );
      if (started.status === 201) {
        // It began first: it exists, and the removal closed it for writing.
        expect(conversations).toHaveLength(1);
        expect(conversations[0].createdAt.getTime()).toBeLessThanOrEqual(
          row.endedAt!.getTime(),
        );
      } else expect(conversations).toHaveLength(0);
    }
  });
});
