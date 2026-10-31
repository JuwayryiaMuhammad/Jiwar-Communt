import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp, type Who } from '../setup/market';

/**
 * ADR 0071: residents report a listing, once each. Reports from enough
 * distinct units take a live listing off the market for review at once;
 * the handlers close each report with an outcome, `removed` taking the
 * listing off. The reporter is told it was looked at, nothing more.
 */
describe('Market — reports', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;
  let carol: Who;
  let dave: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
    carol = await m.owner(s.c, (await m.unit(s.c, 'C')).id);
    dave = await m.owner(s.c, (await m.unit(s.c, 'D')).id);
  }, 180_000);

  afterAll(() => h.close());

  const report = (by: Who, listingId: string, reasonCode = 'scam') =>
    m.http('post', `/market/listings/${listingId}/report`, by.token, {
      reasonCode,
      note: 'Asked me to pay first',
    });

  it('three units reporting take a live listing off for review; the handlers are told once; the seller reads it under review', async () => {
    const listing = await m.live(s.alice, s.marketHandler, {
      title: 'Too-good phone',
    });
    await report(s.bob, listing).expect(201);
    await report(carol, listing).expect(201);
    expect((await m.row(s.c, listing)).status).toBe('live');
    await report(dave, listing, 'misleading').expect(201);
    expect((await m.row(s.c, listing)).status).toBe('under_review');
    await m.http('get', `/market/listings/${listing}`, s.bob.token).expect(404);
    expect(
      (
        await m.notifications(
          s.c,
          s.marketHandler.id,
          'market_listing.under_review',
        )
      ).filter((n) => n.targetId === listing),
    ).toHaveLength(1);
    // Once each; never one's own.
    expect((await report(s.bob, listing).expect(409)).body).toMatchObject({
      code: 'MARKET_REPORT_EXISTS',
    });
    const own = await m.live(s.bob, s.marketHandler, { title: 'Mine' });
    expect((await report(s.bob, own).expect(409)).body).toMatchObject({
      code: 'MARKET_REPORT_OWN_LISTING',
    });
  });

  it('a handler closes a report `removed`: the listing comes off for the report’s code, the reporter is told nothing of the outcome', async () => {
    const listing = await m.live(s.alice, s.marketHandler, { title: 'Pills' });
    const id = (
      (await report(s.bob, listing, 'prohibited').expect(201)).body as {
        id: string;
      }
    ).id;
    const queue = await m.list<Record<string, unknown>>(
      '/market/reports',
      s.marketHandler,
    );
    expect(queue.find((r) => r.id === id)).toMatchObject({
      reasonCode: 'prohibited',
      note: 'Asked me to pay first',
      reporter: { id: s.bob.id },
      listingId: listing,
    });
    await m
      .http('post', `/market/reports/${id}/close`, s.marketHandler.token, {
        reasonCode: 'removed',
      })
      .expect(204);
    expect(await m.row(s.c, listing)).toMatchObject({
      status: 'removed',
      reasonCode: 'prohibited_item',
    });
    expect(
      (await m.notifications(s.c, s.bob.id, 'market_report.closed')).map(
        (n) => [n.targetId, n.params],
      ),
    ).toEqual([[id, {}]]);
    await m
      .http('post', `/market/reports/${id}/close`, s.marketHandler.token, {
        reasonCode: 'warned',
      })
      .expect(409);
  });

  it('a resident never reads the reports', async () => {
    await m.http('get', '/market/reports', s.alice.token).expect(403);
  });

  it('race: reports crossing the threshold at once take the listing off once (3 rounds)', async () => {
    const reporters: Who[] = [];
    for (let i = 0; i < 4; i++)
      reporters.push(await m.owner(s.c, (await m.unit(s.c, `R${i}`)).id));
    for (let round = 0; round < 3; round++) {
      const listing = await m.live(s.alice, s.marketHandler, {
        title: `Race listing ${round}`,
      });
      const results = await Promise.all(
        reporters.map((r) => report(r, listing)),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect((await m.row(s.c, listing)).status).toBe('under_review');
      const audits = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.auditLog.count({
          where: { action: 'market_listing.under_review', targetId: listing },
        }),
      );
      expect(audits).toBe(1);
    }
  });
});
