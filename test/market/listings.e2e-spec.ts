import { auditReaders } from '../setup/audit';
import { eraseNow } from '../setup/erasure';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp, type Who } from '../setup/market';

/**
 * ADR 0071: the market. A resident lists something; where the compound
 * reviews (the default) a handler lets it on; every resident reads it with
 * the seller's building and never a name; the seller withdraws it or marks
 * it sold; a handler turns one down or takes one off with a code; its day
 * ends it.
 */
describe('Market — listings', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;
  let audit: ReturnType<typeof auditReaders>;
  let carol: Who;

  type Listing = Record<string, unknown> & {
    id: string;
    state: string;
    seller: { building: string | null; mine: boolean };
  };

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
    audit = auditReaders(h);
    carol = await m.owner(s.c, (await m.unit(s.c, 'C')).id);
  }, 180_000);

  afterAll(() => h.close());

  /** The one audit row of the action on the listing. */
  async function one(action: string, targetId: string) {
    const rows = await audit.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  describe('listing and review', () => {
    it('a new listing waits for a handler; nobody else sees it until it is let on, and then with a building and no name', async () => {
      const res = await m.listRaw(s.alice).expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const created = res.body as { id: string; status: string };
      expect(Object.keys(created).sort()).toEqual([
        'createdAt',
        'expiresAt',
        'id',
        'kind',
        'status',
      ]);
      expect(created.status).toBe('pending_review');
      await m
        .http('get', `/market/listings/${created.id}`, s.bob.token)
        .expect(404);
      expect((await m.market<Listing>(s.bob)).map((l) => l.id)).not.toContain(
        created.id,
      );
      // The seller reads their own, waiting.
      expect(
        (
          await m
            .http('get', `/market/listings/${created.id}`, s.alice.token)
            .expect(200)
        ).body,
      ).toMatchObject({ state: 'pending_review', seller: { mine: true } });
      // The handler's queue holds it, the seller named.
      const queue = await m.list<Record<string, unknown>>(
        '/market/review?status=pending_review',
        s.marketHandler,
      );
      expect(queue.find((l) => l.id === created.id)).toMatchObject({
        sellerAccount: { id: s.alice.id },
        sellerUnitCode: expect.any(String) as string,
      });

      await m.review(s.marketHandler, created.id, 'approve').expect(204);
      const seen = (
        await m
          .http('get', `/market/listings/${created.id}`, s.bob.token)
          .expect(200)
      ).body as Listing;
      expect(seen).toMatchObject({
        state: 'live',
        price: '1500.00',
        seller: { building: 'A', mine: false },
        unit: null,
      });
      expect(JSON.stringify(seen)).not.toContain(s.alice.id);
      expect(
        (await m.notifications(s.c, s.alice.id, 'market_listing.approved'))
          .map((n) => [n.targetId, n.params])
          .filter(([id]) => id === created.id),
      ).toEqual([[created.id, { listingKind: 'sell' }]]);
      expect(await one('market_listing.approved', created.id)).toMatchObject({
        actorId: s.marketHandler.id,
        metadata: { from: 'pending_review' },
      });
    });

    it('a handler turns one down with a code from the list; the seller is told the code, and it never shows', async () => {
      const { id } = await m.listing(s.alice, { title: 'A rejected lamp' });
      await m.review(s.marketHandler, id, 'reject', 'because').expect(400);
      await m.review(s.marketHandler, id, 'reject', 'duplicate').expect(204);
      await m.review(s.marketHandler, id, 'approve').expect(409);
      expect(
        (await m.notifications(s.c, s.alice.id, 'market_listing.rejected'))
          .filter((n) => n.targetId === id)
          .map((n) => n.params),
      ).toEqual([{ listingKind: 'sell', reason: 'duplicate' }]);
      const mine = await m.list<Record<string, unknown>>(
        '/me/market/listings',
        s.alice,
      );
      expect(mine.find((l) => l.id === id)).toMatchObject({
        state: 'rejected',
        reasonCode: 'duplicate',
      });
    });

    it('where the compound does not review, a listing goes live at once', async () => {
      await m.marketSettings(s.manager, { requiresReview: false });
      try {
        const { status, id } = await m.listing(s.bob, { title: 'A bike' });
        expect(status).toBe('live');
        expect((await m.market<Listing>(carol)).map((l) => l.id)).toContain(id);
      } finally {
        await m.marketSettings(s.manager, { requiresReview: true });
      }
    });
  });

  describe('what a listing needs', () => {
    it('selling needs a price, a gift refuses one, real estate is only a unit, and six photos at most', async () => {
      const fields = async (over: Record<string, unknown>) =>
        (
          (await m.listRaw(s.alice, over).expect(400)).body as {
            fields: { field: string; code: string }[];
          }
        ).fields.map((f) => [f.field, f.code]);
      expect(await fields({ price: undefined })).toEqual([
        ['price', 'FIELD_REQUIRED'],
      ]);
      expect(await fields({ kind: 'give', price: '10' })).toEqual([
        ['price', 'FIELD_NOT_ALLOWED'],
      ]);
      expect(await fields({ category: 'real_estate' })).toEqual([
        ['category', 'INVALID_VALUE'],
      ]);
      expect(await fields({ unitId: s.homeA.id })).toEqual([
        ['unitId', 'FIELD_NOT_ALLOWED'],
      ]);
      const photos = await Promise.all(
        Array.from({ length: 7 }, () => m.photo(s.alice)),
      );
      expect(await fields({ photoFileIds: photos })).toEqual([
        ['photoFileIds', 'INVALID_LENGTH'],
      ]);
    });

    it('a gift and a wanted listing may go without a price; photos show in their order', async () => {
      const photos = [await m.photo(s.bob), await m.photo(s.bob)];
      const id = await m.live(s.bob, s.marketHandler, {
        kind: 'give',
        price: undefined,
        title: 'Free moving boxes',
        photoFileIds: photos,
      });
      const seen = (
        await m.http('get', `/market/listings/${id}`, carol.token).expect(200)
      ).body as Listing & { photos: { url: string | null }[] };
      expect(seen).toMatchObject({ price: null, negotiable: false });
      expect(seen.photos).toHaveLength(2);
      expect(seen.photos.every((p) => typeof p.url === 'string')).toBe(true);
    });

    it('a seller holds at most the compound’s number open at once', async () => {
      await m.marketSettings(s.manager, { maxLivePerAccount: 1 });
      try {
        const dave = await m.owner(s.c, (await m.unit(s.c, 'D')).id);
        await m.listing(dave, { title: 'One thing' });
        const res = await m.listRaw(dave, { title: 'Another' }).expect(409);
        expect(res.body).toMatchObject({
          code: 'MARKET_LISTING_LIMIT_REACHED',
          params: { max: 1 },
        });
      } finally {
        await m.marketSettings(s.manager, { maxLivePerAccount: 10 });
      }
    });
  });

  describe('search', () => {
    it('finds by words, kind, category and price; sorts by price; never an ended or waiting one', async () => {
      const sofa = await m.live(s.alice, s.marketHandler, {
        title: 'Velvet sofa',
        body: 'Green velvet, three seats.',
        price: '4000',
      });
      const chair = await m.live(s.bob, s.marketHandler, {
        title: 'Velvet armchair',
        body: 'Matches a sofa.',
        price: '900',
      });
      const waiting = await m.listing(carol, { title: 'Velvet curtains' });
      const ids = async (query: string) =>
        (await m.market<Listing>(carol, query)).map((l) => l.id);
      const found = await ids('q=velvet');
      expect(found).toEqual(expect.arrayContaining([sofa, chair]));
      expect(found).not.toContain(waiting.id);
      expect(await ids('q=velvet&maxPrice=1000')).toEqual([chair]);
      expect(await ids('q=velvet&minPrice=1000')).toEqual([sofa]);
      expect(await ids('q=velvet&sort=price_asc')).toEqual([chair, sofa]);
      expect(await ids('q=velvet&sort=price_desc')).toEqual([sofa, chair]);
      expect(await ids('q=velvet&kind=give')).toEqual([]);
      // A page at a time, by price.
      const first = (
        await m
          .http(
            'get',
            '/market/listings?q=velvet&sort=price_asc&limit=1',
            carol.token,
          )
          .expect(200)
      ).body as { data: Listing[]; nextCursor: string };
      expect(first.data.map((l) => l.id)).toEqual([chair]);
      const second = (
        await m
          .http(
            'get',
            `/market/listings?q=velvet&sort=price_asc&limit=1&cursor=${first.nextCursor}`,
            carol.token,
          )
          .expect(200)
      ).body as { data: Listing[] };
      expect(second.data.map((l) => l.id)).toEqual([sofa]);

      await m
        .http('post', `/market/listings/${sofa}/sold`, s.alice.token)
        .expect(204);
      expect(await ids('q=velvet')).toEqual([chair]);
    });

    it('a minimum above the maximum is refused', async () => {
      const res = await m
        .http('get', '/market/listings?minPrice=10&maxPrice=5', carol.token)
        .expect(400);
      expect(res.body).toMatchObject({
        fields: [{ field: 'maxPrice', code: 'INVALID_VALUE' }],
      });
    });
  });

  describe('the seller', () => {
    it('changes a live listing; where the compound reviews it goes back for review, its words audited as changed only', async () => {
      const id = await m.live(s.alice, s.marketHandler, { title: 'Desk lamp' });
      const res = await m
        .http('patch', `/market/listings/${id}`, s.alice.token, {
          title: 'Brass desk lamp',
          price: '250',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        title: 'Brass desk lamp',
        price: '250.00',
        state: 'pending_review',
      });
      expect((await one('market_listing.updated', id)).changes).toEqual({
        title: { changed: true },
        price: { from: '1500.00', to: '250.00' },
      });
      // Nobody else changes it.
      await m
        .http('patch', `/market/listings/${id}`, s.bob.token, { price: '1' })
        .expect(404);
    });

    it('withdraws it, after which nothing changes it', async () => {
      const id = await m.live(s.alice, s.marketHandler, { title: 'Old radio' });
      await m
        .http('post', `/market/listings/${id}/withdraw`, s.alice.token)
        .expect(204);
      const again = await m
        .http('post', `/market/listings/${id}/sold`, s.alice.token)
        .expect(409);
      expect(again.body).toMatchObject({
        code: 'MARKET_LISTING_ENDED',
        params: { status: 'withdrawn' },
      });
      await m.review(s.marketHandler, id, 'remove', 'scam').expect(409);
    });
  });

  describe('the handlers', () => {
    it('take a live listing off with a code; the seller is told, the market no longer shows it', async () => {
      const id = await m.live(s.bob, s.marketHandler, { title: 'Fake watch' });
      await m.review(s.marketHandler, id, 'remove', 'scam').expect(204);
      expect(
        (await m.notifications(s.c, s.bob.id, 'market_listing.removed'))
          .filter((n) => n.targetId === id)
          .map((n) => n.params),
      ).toEqual([{ listingKind: 'sell', reason: 'scam' }]);
      await m.http('get', `/market/listings/${id}`, carol.token).expect(404);
      expect((await m.row(s.c, id)).decidedById).toBe(s.marketHandler.id);
    });

    it('a resident never reaches the review', async () => {
      await m.http('get', '/market/review', s.alice.token).expect(403);
    });
  });

  describe('its day', () => {
    it('the seller is told two days before, once; when its day passes it reads expired at once and the sweep ends it', async () => {
      const id = await m.live(s.alice, s.marketHandler, { title: 'Cot' });
      await m.nearExpiry(s.c, id);
      await m.sweep();
      await m.sweep();
      expect(
        (
          await m.notifications(s.c, s.alice.id, 'market_listing.expiring')
        ).filter((n) => n.targetId === id),
      ).toHaveLength(1);

      await m.expire(s.c, id);
      await m.http('get', `/market/listings/${id}`, s.bob.token).expect(404);
      expect(
        (
          await m
            .http('get', `/market/listings/${id}`, s.alice.token)
            .expect(200)
        ).body,
      ).toMatchObject({ state: 'expired' });
      await m.sweep();
      expect(await m.row(s.c, id)).toMatchObject({
        status: 'expired',
        endedAt: expect.any(Date) as Date,
      });
    });
  });

  describe('export and erasure', () => {
    it('the export holds every listing of the account’s, the photos as a count; nobody else’s', async () => {
      const seller = await m.erasable(s.c, 'X');
      const live = await m.live(seller, s.marketHandler, {
        title: 'EXPORT-MY-LISTING',
        photoFileIds: [await m.photo(seller)],
      });
      const { id: withdrawn } = await m.listing(seller, {
        title: 'EXPORT-MY-WITHDRAWN',
      });
      await m
        .http('post', `/market/listings/${withdrawn}/withdraw`, seller.token)
        .expect(204);
      await m.live(s.bob, s.marketHandler, { title: 'NOT-MINE-LISTING' });
      const archive = await m.exportOf(seller);
      const text = archive.text('market/listings.json');
      const rows = JSON.parse(text) as {
        id: string;
        state: string;
        photoCount: number;
      }[];
      expect(rows.map((r) => r.id).sort()).toEqual([live, withdrawn].sort());
      expect(rows.find((r) => r.id === live)).toMatchObject({
        photoCount: 1,
      });
      expect(text).toContain('EXPORT-MY-LISTING');
      expect(text).not.toContain('NOT-MINE-LISTING');
      expect(text).not.toMatch(/https?:\/\//);
    });

    it('erased: open listings withdrawn (`seller_erased`), the words of every one gone, the photos with their files; the rows stay', async () => {
      const seller = await m.erasable(s.c, 'Y');
      const live = await m.live(seller, s.marketHandler, {
        title: 'ERASE-MY-LISTING',
        photoFileIds: [await m.photo(seller)],
      });
      const { id: sold } = await m.listing(seller, { title: 'ERASE-MY-SOLD' });
      await m.review(s.marketHandler, sold, 'approve').expect(204);
      await m
        .http('post', `/market/listings/${sold}/sold`, seller.token)
        .expect(204);
      await eraseNow(h, s.c, seller.id);
      expect(await m.row(s.c, live)).toMatchObject({
        status: 'withdrawn',
        reasonCode: 'seller_erased',
        title: null,
        body: null,
        erasedAt: expect.any(Date) as Date,
      });
      expect(await m.row(s.c, sold)).toMatchObject({
        status: 'sold',
        title: null,
        body: null,
        erasedAt: expect.any(Date) as Date,
      });
      expect(
        await m.x.asManager(s.c, () =>
          m.x.prisma.tenant.marketListingPhoto.count({
            where: { listingId: live },
          }),
        ),
      ).toBe(0);
    });
  });

  describe('leaving', () => {
    it('a seller who leaves the compound loses their open listings', async () => {
      const home = await m.unit(s.c, 'E');
      const erin = await m.owner(s.c, home.id);
      const id = await m.live(erin, s.marketHandler, { title: 'Shelves' });
      await m.moveOut(s.c, home.id, erin);
      expect(await m.row(s.c, id)).toMatchObject({
        status: 'withdrawn',
        reasonCode: 'seller_left',
      });
    });
  });
});
