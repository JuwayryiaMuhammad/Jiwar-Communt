import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp } from '../setup/market';

/**
 * ADR 0071: partner offers. The staff who keep the partners publish an
 * offer from a day to a day and withdraw it; residents read the ones in
 * force today, of partners not suspended.
 */
describe('Market — partner offers', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;
  let partnerId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
    partnerId = await m.partner(s.c);
  }, 180_000);

  afterAll(() => h.close());

  const publish = (over: Record<string, unknown> = {}) =>
    m.http('post', `/staff/partners/${partnerId}/offers`, s.manager.token, {
      titleEn: 'Ten percent off',
      titleAr: 'خصم عشرة بالمئة',
      bodyEn: 'On every cleaning this month.',
      bodyAr: 'على كل تنظيف هذا الشهر.',
      validFromOn: day(0),
      validToOn: day(10),
      ...over,
    });

  it('an offer in force reaches residents with its partner’s names; a future one and a withdrawn one do not', async () => {
    const now = (
      (await publish().expect(201)).body as { id: string; status: string }
    ).id;
    const later = (
      (await publish({ validFromOn: day(5), validToOn: day(9) }).expect(201))
        .body as { id: string }
    ).id;
    const seen = await m.list<Record<string, unknown>>('/market/offers', s.bob);
    expect(seen.map((o) => o.id)).toEqual([now]);
    expect(seen[0]).toMatchObject({
      partnerId,
      partnerNameEn: 'Clean Co',
      titleEn: 'Ten percent off',
      validFromOn: day(0),
      validToOn: day(10),
    });
    await m
      .http('post', `/staff/partner-offers/${now}/withdraw`, s.manager.token)
      .expect(204);
    await m
      .http('post', `/staff/partner-offers/${now}/withdraw`, s.manager.token)
      .expect(409);
    expect(await m.list('/market/offers', s.bob)).toEqual([]);
    const staff = await m.list<Record<string, unknown>>(
      '/staff/partner-offers',
      s.manager,
    );
    expect(staff.map((o) => [o.id, o.status])).toEqual(
      expect.arrayContaining([
        [now, 'withdrawn'],
        [later, 'active'],
      ]),
    );
  });

  it('its days: an end before the start, a past end or more than a year are refused', async () => {
    for (const over of [
      { validFromOn: day(5), validToOn: day(4) },
      { validFromOn: day(-10), validToOn: day(-1) },
      { validFromOn: day(0), validToOn: day(400) },
    ])
      expect(
        ((await publish(over).expect(400)).body as { fields: object[] }).fields,
      ).toMatchObject([{ field: 'validToOn', code: 'INVALID_VALUE' }]);
  });

  it('a suspended partner’s offers leave the market', async () => {
    await publish({ titleEn: 'While it lasts' }).expect(201);
    expect((await m.list('/market/offers', s.bob)).length).toBeGreaterThan(0);
    await m.x.asManager(s.c, () =>
      m.x.prisma.tenant.partner.update({
        where: { id: partnerId },
        // As a suspension leaves it (ADR 0060's status shape).
        data: {
          status: 'suspended',
          suspendedReason: 'other',
          suspendedAt: new Date(),
          suspendedById: s.c.managerId,
        },
      }),
    );
    expect(await m.list('/market/offers', s.bob)).toEqual([]);
  });

  it('a resident never publishes', async () => {
    await m
      .http('post', `/staff/partners/${partnerId}/offers`, s.alice.token, {})
      .expect(403);
  });
});
