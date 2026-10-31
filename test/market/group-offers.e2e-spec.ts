import { GROUP_OFFERS_SWEEP } from '../../src/partners/group-offers/group-offers.service';
import { at, dbClock, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp, type Who } from '../setup/market';

/**
 * ADR 0071: group offers. The handlers publish one, with an interest phase
 * first or not; residents join with a quantity for one of their units and
 * may leave until it closes; the sweep confirms it with enough households
 * or it fails; each participant is told. No money passes through Jiwar.
 */
describe('Market — group offers', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;
  let carol: Who;
  let carolUnit: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
    carolUnit = (await m.unit(s.c, 'C')).id;
    carol = await m.owner(s.c, carolUnit);
  }, 180_000);

  afterAll(() => h.close());

  type Offer = Record<string, unknown> & { id: string; status: string };
  const publish = async (over: Record<string, unknown> = {}) =>
    (
      await m
        .http('post', '/staff/group-offers', s.manager.token, {
          titleEn: 'Water filters',
          titleAr: 'فلاتر مياه',
          bodyEn: 'Installed, one a home.',
          bodyAr: 'تركيب فلتر لكل وحدة.',
          listPrice: '1200',
          groupPrice: '950',
          minParticipants: 2,
          closesAt: at(day(5), 20).toISOString(),
          ...over,
        })
        .expect(201)
    ).body as Offer;
  const join = (by: Who, id: string, unitId: string, quantity = 1) =>
    m.http('post', `/market/group-offers/${id}/join`, by.token, {
      unitId,
      quantity,
    });
  const sweep = () => m.sweep_(GROUP_OFFERS_SWEEP, dbClock());

  it('interest first: a count, then it opens and the interested are told; they join, see their saving, and the sweep confirms it', async () => {
    const offer = await publish({
      interestClosesAt: at(day(2), 20).toISOString(),
    });
    expect(offer.status).toBe('interest');
    await m
      .http(
        'post',
        `/market/group-offers/${offer.id}/interest`,
        s.alice.token,
        {
          unitId: s.homeA.id,
        },
      )
      .expect(201);
    await join(s.bob, offer.id, s.homeB.id).expect(409);
    await m
      .http('post', `/staff/group-offers/${offer.id}/open`, s.manager.token)
      .expect(204);
    expect(
      (await m.notifications(s.c, s.alice.id, 'group_offer.opened')).map(
        (n) => n.targetId,
      ),
    ).toEqual([offer.id]);
    const mine = (await join(s.alice, offer.id, s.homeA.id, 2).expect(201))
      .body as Offer;
    expect(mine).toMatchObject({
      interested: 1,
      joined: 1,
      quantity: 2,
      myQuantity: 2,
      mySaving: '500.00',
    });
    await join(s.bob, offer.id, s.homeB.id).expect(201);
    await m.timeMachine(s.c, offer.id);
    await sweep();
    expect(
      (
        await m
          .http('get', `/market/group-offers/${offer.id}`, s.bob.token)
          .expect(200)
      ).body,
    ).toMatchObject({ status: 'confirmed', joined: 2 });
    for (const who of [s.alice, s.bob])
      expect(
        (await m.notifications(s.c, who.id, 'group_offer.confirmed')).map(
          (n) => n.targetId,
        ),
      ).toContain(offer.id);
  });

  it('too few households: it fails, and those who joined are told', async () => {
    const offer = await publish({ minParticipants: 3 });
    await join(carol, offer.id, carolUnit).expect(201);
    await m.timeMachine(s.c, offer.id);
    await sweep();
    expect(
      (
        await m
          .http('get', `/market/group-offers/${offer.id}`, carol.token)
          .expect(200)
      ).body,
    ).toMatchObject({ status: 'failed' });
    expect(
      (await m.notifications(s.c, carol.id, 'group_offer.failed')).map(
        (n) => n.targetId,
      ),
    ).toContain(offer.id);
  });

  it('a joiner leaves while it is open; the handlers call one off with a code', async () => {
    const offer = await publish();
    await join(carol, offer.id, carolUnit).expect(201);
    expect(
      (
        await m
          .http('post', `/market/group-offers/${offer.id}/leave`, carol.token)
          .expect(200)
      ).body,
    ).toMatchObject({ joined: 0, myQuantity: null });
    await join(carol, offer.id, carolUnit).expect(201);
    await m
      .http('post', `/staff/group-offers/${offer.id}/cancel`, s.manager.token, {
        reasonCode: 'price_changed',
      })
      .expect(204);
    expect(
      (await m.notifications(s.c, carol.id, 'group_offer.cancelled'))
        .filter((n) => n.targetId === offer.id)
        .map((n) => n.params),
    ).toEqual([{ reason: 'price_changed' }]);
    await join(s.bob, offer.id, s.homeB.id).expect(409);
  });

  it('the export holds every place the account took, left ones too, never who else joined', async () => {
    const who = await m.erasable(s.c, 'X');
    const offer = await publish({ titleEn: 'EXPORT-GROUP-OFFER' });
    await join(who, offer.id, who.unitId, 3).expect(201);
    await m
      .http('post', `/market/group-offers/${offer.id}/leave`, who.token)
      .expect(200);
    await join(who, offer.id, who.unitId, 2).expect(201);
    await join(carol, offer.id, carolUnit).expect(201);
    const text = (await m.exportOf(who)).text('partners/group-offers.json');
    const rows = JSON.parse(text) as {
      offerId: string;
      titleEn: string;
      kind: string;
      quantity: number;
      leftAt: string | null;
    }[];
    expect(
      rows.map((r) => [r.offerId, r.titleEn, r.kind, r.quantity, !!r.leftAt]),
    ).toEqual([
      [offer.id, 'EXPORT-GROUP-OFFER', 'join', 3, true],
      [offer.id, 'EXPORT-GROUP-OFFER', 'join', 2, false],
    ]);
    expect(text).not.toContain(carol.id);
    expect(text).not.toContain(carolUnit);
  });

  it('only for one of the caller’s units; never another’s', async () => {
    const offer = await publish();
    await join(carol, offer.id, s.homeA.id).expect(404);
  });

  it('race: the last places — two joins at once, one fits (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const offer = await publish({ maxParticipants: 4 });
      await join(carol, offer.id, carolUnit, 2).expect(201);
      const [a, b] = await Promise.all([
        join(s.alice, offer.id, s.homeA.id, 2),
        join(s.bob, offer.id, s.homeB.id, 2),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(
        (
          await m
            .http('get', `/market/group-offers/${offer.id}`, carol.token)
            .expect(200)
        ).body,
      ).toMatchObject({ quantity: 4, joined: 2 });
    }
  });

  it('race: a join and a leave against the close — the close counts exactly who is in (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const offer = await publish({ minParticipants: 2 });
      await join(carol, offer.id, carolUnit).expect(201);
      await join(s.alice, offer.id, s.homeA.id).expect(201);
      await m.timeMachine(s.c, offer.id);
      const [late, leaving] = await Promise.all([
        join(s.bob, offer.id, s.homeB.id),
        m.http('post', `/market/group-offers/${offer.id}/leave`, s.alice.token),
        sweep(),
      ]);
      // Its time passed: neither a join nor a leave lands any more.
      expect(late.status).toBe(409);
      expect(leaving.status).toBe(409);
      await sweep();
      expect(
        (
          await m
            .http('get', `/market/group-offers/${offer.id}`, carol.token)
            .expect(200)
        ).body,
      ).toMatchObject({ status: 'confirmed', joined: 2 });
    }
  });
});
