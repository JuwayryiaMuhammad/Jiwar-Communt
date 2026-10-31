import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp } from '../setup/market';

/**
 * ADR 0071: a unit for sale or to let. Only its owner lists it, while they
 * own it; one open listing a unit and a kind; the listing shows the unit's
 * type, area, building and floor, never its code; it ends when the owner's
 * ownership does.
 */
describe('Market — unit listings', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
    await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.unit.update({
        where: { id: s.homeA.id },
        data: { floor: 3, unitType: 'apartment', areaSqm: '142.50' },
      }),
    );
  }, 180_000);

  afterAll(() => h.close());

  const forSale = (unitId: string, over: Record<string, unknown> = {}) => ({
    kind: 'unit_sale',
    category: 'real_estate',
    title: 'Three bedrooms, garden view',
    body: 'Finished, south facing.',
    price: '4500000',
    unitId,
    ...over,
  });

  it('the owner lists their unit: its type, area, building and floor show, never its code', async () => {
    const id = await m.live(s.alice, s.marketHandler, forSale(s.homeA.id));
    const seen = (
      await m.http('get', `/market/listings/${id}`, s.bob.token).expect(200)
    ).body as Record<string, unknown>;
    expect(seen).toMatchObject({
      kind: 'unit_sale',
      category: 'real_estate',
      price: '4500000.00',
      unit: { type: 'apartment', areaSqm: '142.50', building: 'A', floor: 3 },
      seller: { building: 'A', mine: false },
    });
    expect(JSON.stringify(seen)).not.toContain(s.homeA.code);
    // One open listing of a kind: a second sale is refused, a letting is not.
    const again = await m.listRaw(s.alice, forSale(s.homeA.id)).expect(409);
    expect(again.body).toMatchObject({
      code: 'MARKET_UNIT_LISTED',
      params: { listingId: id },
    });
    await m
      .listRaw(
        s.alice,
        forSale(s.homeA.id, { kind: 'unit_rent', price: '30000' }),
      )
      .expect(201);
  });

  it('nobody but the owner lists it: a tenant, another unit’s owner; a landlord who lives elsewhere does', async () => {
    const rented = await m.unit(s.c, 'B');
    const landlord = await m.landlord(s.c, rented.id);
    const tenant = await m.tenant(s.c, rented.id);
    const refused = await m.listRaw(tenant, forSale(rented.id)).expect(403);
    expect(refused.body).toMatchObject({ code: 'MARKET_UNIT_NOT_OWNED' });
    await m.listRaw(s.bob, forSale(rented.id)).expect(403);
    // The landlord, who does not live there, does own it.
    await m
      .listRaw(
        landlord,
        forSale(rented.id, { kind: 'unit_rent', price: '20000' }),
      )
      .expect(201);
  });

  it('a unit kind names its unit and is real estate', async () => {
    const res = await m
      .listRaw(
        s.alice,
        forSale(s.homeA.id, { unitId: undefined, category: 'furniture' }),
      )
      .expect(400);
    expect(
      (res.body as { fields: { field: string; code: string }[] }).fields.map(
        (f) => [f.field, f.code],
      ),
    ).toEqual([
      ['unitId', 'FIELD_REQUIRED'],
      ['category', 'INVALID_VALUE'],
    ]);
  });

  it('the listing ends when the owner no longer owns the unit, wherever else they live', async () => {
    const home = await m.unit(s.c, 'C');
    const other = await m.unit(s.c, 'C');
    const owner = await m.owner(s.c, home.id);
    await m.x.asManager(s.c, () =>
      m.x.residents.addOccupancy(owner.id, {
        unitId: other.id,
        occupancyType: 'owner',
        resides: false,
      }),
    );
    const id = await m.live(owner, s.marketHandler, forSale(other.id));
    const occupancy = (await m.x.occupancies(s.c, other.id)).find(
      (o) => o.accountId === owner.id && o.status === 'active',
    )!;
    await m.x.asManager(s.c, () =>
      m.x.residents.endOccupancy(occupancy.id, {
        code: 'other',
        text: 'Sold the flat',
      }),
    );
    expect(await m.row(s.c, id)).toMatchObject({
      status: 'withdrawn',
      reasonCode: 'owner_left',
    });
  });

  it('race: two listings of one unit at once leave one open (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const home = await m.unit(s.c, 'D');
      const owner = await m.owner(s.c, home.id);
      const results = await Promise.all([
        m.listRaw(owner, forSale(home.id, { title: `Sale one ${round}` })),
        m.listRaw(owner, forSale(home.id, { title: `Sale two ${round}` })),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const open = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.marketListing.count({
          where: {
            unitId: home.id,
            status: { in: ['pending_review', 'live', 'under_review'] },
          },
        }),
      );
      expect(open).toBe(1);
    }
  });
});
