import { eraseNow } from '../setup/erasure';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp, type Who } from '../setup/market';

/**
 * ADR 0071: a resident's small shop. One open an account; a handler opens
 * it, turns it down or suspends it with a code, and reinstates it; its
 * listings appear under it; readers see its building, never a person.
 */
describe('Market — shops', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;
  let carol: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
    carol = await m.owner(s.c, (await m.unit(s.c, 'C')).id);
  }, 180_000);

  afterAll(() => h.close());

  const open = (by: Who, over: Record<string, unknown> = {}) =>
    m.http('post', '/market/shops', by.token, {
      nameEn: 'Home bakery',
      nameAr: 'مخبز منزلي',
      description: 'Bread on Fridays.',
      category: 'food',
      ...over,
    });
  const onShop = (
    id: string,
    action: 'approve' | 'reject' | 'suspend',
    reasonCode?: string,
  ) =>
    m.http(
      'post',
      `/market/shop-review/${id}/${action}`,
      s.marketHandler.token,
      reasonCode ? { reasonCode } : {},
    );

  it('a resident opens a shop; it waits, then opens; others see its building and never its owner', async () => {
    const res = await open(s.alice).expect(201);
    const shop = res.body as { id: string; status: string; mine: boolean };
    expect(shop).toMatchObject({ status: 'pending', mine: true });
    await m.http('get', `/market/shops/${shop.id}`, s.bob.token).expect(404);
    await onShop(shop.id, 'approve').expect(204);
    const seen = (
      await m.http('get', `/market/shops/${shop.id}`, s.bob.token).expect(200)
    ).body as Record<string, unknown>;
    expect(seen).toMatchObject({
      status: 'active',
      building: 'A',
      mine: false,
      liveListings: 0,
    });
    expect(JSON.stringify(seen)).not.toContain(s.alice.id);
    expect(
      (await m.notifications(s.c, s.alice.id, 'market_shop.approved')).map(
        (n) => n.targetId,
      ),
    ).toEqual([shop.id]);
    // One open shop an account.
    expect((await open(s.alice).expect(409)).body).toMatchObject({
      code: 'MARKET_SHOP_EXISTS',
      params: { shopId: shop.id },
    });
    // Its owner lists under it; nobody else may.
    const listing = await m.live(s.alice, s.marketHandler, {
      title: 'Sourdough loaf',
      category: 'food',
      price: '60',
      shopId: shop.id,
    });
    expect(
      (
        await m
          .http('get', `/market/listings/${listing}`, s.bob.token)
          .expect(200)
      ).body,
    ).toMatchObject({ shopId: shop.id });
    expect(
      (await m.http('get', `/market/shops/${shop.id}`, s.bob.token).expect(200))
        .body,
    ).toMatchObject({ liveListings: 1 });
    await m
      .listRaw(s.bob, { title: 'Not my shop', shopId: shop.id })
      .expect(404);
  });

  it('a handler suspends an open shop with a code and reinstates it; turns a waiting one down, which closes it', async () => {
    const shop = (
      (await open(s.bob, { nameEn: 'Bike fixes' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await onShop(shop, 'suspend', 'inactive').expect(409);
    await onShop(shop, 'approve').expect(204);
    await onShop(shop, 'suspend', 'because').expect(400);
    await onShop(shop, 'suspend', 'inactive').expect(204);
    await m.http('get', `/market/shops/${shop}`, carol.token).expect(404);
    expect(
      (await m.notifications(s.c, s.bob.id, 'market_shop.suspended')).map(
        (n) => n.params,
      ),
    ).toEqual([{ reason: 'inactive' }]);
    await onShop(shop, 'approve').expect(204);
    await m.http('get', `/market/shops/${shop}`, carol.token).expect(200);

    const turned = (
      (await open(carol, { nameEn: 'Odd jobs' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await onShop(turned, 'reject', 'incomplete').expect(204);
    expect(
      (await m.http('get', '/me/market/shop', carol.token).expect(200)).body,
    ).toMatchObject({ id: turned, status: 'closed', reasonCode: 'incomplete' });
    // Closed, so another may be opened.
    await open(carol, { nameEn: 'Odd jobs again' }).expect(201);
  });

  it('the owner closes their shop; nothing reopens a closed one', async () => {
    const dave = await m.owner(s.c, (await m.unit(s.c, 'D')).id);
    const shop = (
      (await open(dave, { nameEn: 'Plants' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await m.http('post', '/me/market/shop/close', dave.token).expect(204);
    await onShop(shop, 'approve').expect(409);
    await m.http('post', '/me/market/shop/close', dave.token).expect(404);
  });

  it('a shop closes when its owner leaves the compound', async () => {
    const home = await m.unit(s.c, 'E');
    const erin = await m.owner(s.c, home.id);
    const shop = (
      (await open(erin, { nameEn: 'Sewing' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await m.moveOut(s.c, home.id, erin);
    const row = await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.marketShop.findUniqueOrThrow({ where: { id: shop } }),
    );
    expect(row).toMatchObject({ status: 'closed', reasonCode: 'owner_left' });
  });

  it('the export holds every shop the account opened, closed ones too; nobody else’s', async () => {
    const owner = await m.erasable(s.c, 'X');
    const first = (
      (await open(owner, { nameEn: 'EXPORT-FIRST-SHOP' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await m.http('post', '/me/market/shop/close', owner.token).expect(204);
    const second = (
      (await open(owner, { nameEn: 'EXPORT-SECOND-SHOP' }).expect(201))
        .body as { id: string }
    ).id;
    await open(carol, { nameEn: 'NOT-MINE-SHOP' });
    const text = (await m.exportOf(owner)).text('market/shops.json');
    const rows = JSON.parse(text) as { id: string; status: string }[];
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [first, 'closed'],
      [second, 'pending'],
    ]);
    expect(text).not.toContain('NOT-MINE-SHOP');
  });

  it('erased: the shop closes (`owner_erased`) and its words go; the row stays', async () => {
    const owner = await m.erasable(s.c, 'Y');
    const shop = (
      (await open(owner, { nameEn: 'ERASE-MY-SHOP' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await onShop(shop, 'approve').expect(204);
    await eraseNow(h, s.c, owner.id);
    const row = await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.marketShop.findUniqueOrThrow({ where: { id: shop } }),
    );
    expect(row).toMatchObject({
      status: 'closed',
      reasonCode: 'owner_erased',
      nameEn: null,
      nameAr: null,
      description: null,
      erasedAt: expect.any(Date) as Date,
    });
  });
});
