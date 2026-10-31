import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

interface Entry {
  id: string;
  status: string;
  offerExpiresAt: string | null;
  bookingId: string | null;
}

const MINUTE = 60_000;

/**
 * ADR 0070: a resident waits for a full slot — refused while it has room,
 * three at once, once per slot. What frees room (a cancel, a rejection, a
 * companion declining) is offered in the order of joining and held for the
 * compound's hold; a held place is taken for everyone else. Claimed, it is
 * the entry's booking; expired, the sweep lapses it and offers the next; a
 * closure closes the slot's entries.
 */
describe('Bookings: the waitlist (ADR 0070)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
  }, 180_000);

  afterAll(() => h.close());

  /** A court of one booking a slot, and a fresh resident's home. */
  const court = () => f.facility(s.c, s.manager, { weeklyQuota: 20 });
  const someone = async (): Promise<{ who: Who; unitId: string }> => {
    const home = await f.unit(s.c, 'A');
    return { who: await f.owner(s.c, home.id), unitId: home.id };
  };
  const wait = (as: Who, unitId: string, facilityId: string, startsAt: Date) =>
    f.http('post', `/facilities/${facilityId}/waitlist`, as.token, {
      unitId,
      startsAt: startsAt.toISOString(),
    });
  const entry = (c: string) =>
    f.inTx(s.c, (tx) =>
      tx.bookingWaitlistEntry.findUniqueOrThrow({ where: { id: c } }),
    );
  const claim = (as: Who, id: string) =>
    f.http('post', `/booking-waitlist/${id}/claim`, as.token);

  it('only a full slot: freed, it is offered and held; claimed, it is booked', async () => {
    const id = await court();
    const slot = at(day(3), 10);
    const x = await someone();
    const open = await wait(x.who, x.unitId, id, slot);
    expect(open.status).toBe(409);
    expect(err(open).code).toBe('BOOKING_SLOT_AVAILABLE');
    const held = await f.book(s.alice, s.homeA.id, id, slot);
    const e = (await wait(x.who, x.unitId, id, slot).expect(201)).body as Entry;
    expect(e.status).toBe('waiting');
    expect(err(await wait(x.who, x.unitId, id, slot)).code).toBe(
      'WAITLIST_EXISTS',
    );
    await f.cancel(s.alice, held.id).expect(204);
    const offered = await entry(e.id);
    expect(offered.status).toBe('offered');
    expect(
      offered.offerExpiresAt!.getTime() - offered.offeredAt!.getTime(),
    ).toBe(30 * MINUTE);
    expect(
      await f.notifications(s.c, x.who.id, 'booking_waitlist.offered'),
    ).toHaveLength(1);
    // The held place is taken for anyone else.
    const other = await f.bookRaw(s.bob, s.homeB.id, id, slot);
    expect(other.status).toBe(409);
    expect(err(other).code).toBe('BOOKING_SLOT_FULL');
    expect(
      (await f.slots(s.bob, id, day(3))).find(
        (sl) => new Date(sl.startsAt).getTime() === slot.getTime(),
      )?.state,
    ).toBe('full');
    const booked = (await claim(x.who, e.id).expect(201)).body as {
      id: string;
    };
    expect(await entry(e.id)).toMatchObject({
      status: 'booked',
      bookingId: booked.id,
    });
  });

  it('three slots at once per account', async () => {
    const id = await court();
    const x = await someone();
    for (const hour of [8, 9, 10, 11]) {
      await f.book(s.bob, s.homeB.id, id, at(day(4), hour));
      if (hour < 11)
        await wait(x.who, x.unitId, id, at(day(4), hour)).expect(201);
    }
    const fourth = await wait(x.who, x.unitId, id, at(day(4), 11));
    expect(fourth.status).toBe(409);
    expect(err(fourth)).toMatchObject({
      code: 'WAITLIST_LIMIT_REACHED',
      params: { max: 3 },
    });
  });

  it('in the order of joining: one left with an offer passes it on; the sweep lapses an expired one and offers the next', async () => {
    const id = await court();
    const slot = at(day(5), 10);
    const held = await f.book(s.alice, s.homeA.id, id, slot);
    const [x, y, z] = [await someone(), await someone(), await someone()];
    const ex = (
      (await wait(x.who, x.unitId, id, slot).expect(201)).body as Entry
    ).id;
    const ey = (
      (await wait(y.who, y.unitId, id, slot).expect(201)).body as Entry
    ).id;
    const ez = (
      (await wait(z.who, z.unitId, id, slot).expect(201)).body as Entry
    ).id;
    await f.cancel(s.alice, held.id).expect(204);
    expect((await entry(ex)).status).toBe('offered');
    expect((await entry(ey)).status).toBe('waiting');
    await f
      .http('post', `/booking-waitlist/${ex}/leave`, x.who.token)
      .expect(200);
    const yOffer = await entry(ey);
    expect(yOffer.status).toBe('offered');
    await f.sweep(
      'facilities.waitlist',
      new Date(yOffer.offerExpiresAt!.getTime() + MINUTE),
    );
    expect((await entry(ey)).status).toBe('lapsed');
    expect((await entry(ez)).status).toBe('offered');
  });

  it('a closure closes the slot’s entries and tells them', async () => {
    const id = await court();
    const slot = at(day(6), 10);
    await f.book(s.alice, s.homeA.id, id, slot);
    const x = await someone();
    const e = (
      (await wait(x.who, x.unitId, id, slot).expect(201)).body as Entry
    ).id;
    await f
      .http('post', `/staff/facilities/${id}/closures`, s.manager.token, {
        startsAt: at(day(6), 9).toISOString(),
        endsAt: at(day(6), 12).toISOString(),
        reasonCode: 'weather',
      })
      .expect(201);
    expect((await entry(e)).status).toBe('closed');
    expect(
      await f.notifications(s.c, x.who.id, 'booking_waitlist.closed'),
    ).toHaveLength(1);
  });

  it.each([1, 2, 3])(
    'round %i: a seat freed while someone books it directly — the hold holds, the slot never overfills',
    async () => {
      const id = await court();
      const slot = at(day(7), 10);
      const held = await f.book(s.alice, s.homeA.id, id, slot);
      const x = await someone();
      const e = (
        (await wait(x.who, x.unitId, id, slot).expect(201)).body as Entry
      ).id;
      const [cancelled, direct] = await Promise.all([
        f.cancel(s.alice, held.id),
        f.bookRaw(s.bob, s.homeB.id, id, slot),
      ]);
      expect(cancelled.status).toBe(204);
      // Booked before the cancel: the slot was full. After: the offer holds it.
      expect(direct.status).toBe(409);
      expect((await entry(e)).status).toBe('offered');
      expect(await f.holding(s.c, id)).toBe(0);
    },
  );

  it.each([1, 2, 3])(
    'round %i: one offer claimed twice at once — one booking',
    async () => {
      const id = await court();
      const slot = at(day(8), 10);
      const held = await f.book(s.alice, s.homeA.id, id, slot);
      const x = await someone();
      const e = (
        (await wait(x.who, x.unitId, id, slot).expect(201)).body as Entry
      ).id;
      await f.cancel(s.alice, held.id).expect(204);
      const both = await Promise.all([claim(x.who, e), claim(x.who, e)]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await f.holding(s.c, id)).toBe(1);
    },
  );

  it.each([1, 2, 3])(
    'round %i: two cancels at once in a slot of two — two offers, in the order of joining',
    async () => {
      const id = await f.facility(s.c, s.manager, {
        weeklyQuota: 20,
        capacity: 2,
      });
      const slot = at(day(9), 10);
      const a = await f.book(s.alice, s.homeA.id, id, slot);
      const b = await f.book(s.bob, s.homeB.id, id, slot);
      const [x, y, z] = [await someone(), await someone(), await someone()];
      const ids = [];
      for (const p of [x, y, z])
        ids.push(
          ((await wait(p.who, p.unitId, id, slot).expect(201)).body as Entry)
            .id,
        );
      await Promise.all([f.cancel(s.alice, a.id), f.cancel(s.bob, b.id)]);
      expect((await Promise.all(ids.map(entry))).map((e) => e.status)).toEqual([
        'offered',
        'offered',
        'waiting',
      ]);
    },
  );

  it.each([1, 2, 3])(
    'round %i: the sweep lapses an offer while its holder claims it — booked, or lapsed and refused',
    async () => {
      const id = await court();
      const slot = at(day(10), 10);
      const held = await f.book(s.alice, s.homeA.id, id, slot);
      const x = await someone();
      const e = (
        (await wait(x.who, x.unitId, id, slot).expect(201)).body as Entry
      ).id;
      await f.cancel(s.alice, held.id).expect(204);
      const offer = await entry(e);
      const [claimed] = await Promise.all([
        claim(x.who, e),
        f.sweep(
          'facilities.waitlist',
          new Date(offer.offerExpiresAt!.getTime() + MINUTE),
        ),
      ]);
      const after = await entry(e);
      if (claimed.status === 201) {
        expect(after).toMatchObject({
          status: 'booked',
          bookingId: (claimed.body as { id: string }).id,
        });
        expect(await f.holding(s.c, id)).toBe(1);
      } else {
        expect(claimed.status).toBe(409);
        expect(err(claimed)).toMatchObject({
          code: 'WAITLIST_OFFER_INVALID',
          params: { status: 'lapsed' },
        });
        expect(after.status).toBe('lapsed');
        expect(await f.holding(s.c, id)).toBe(0);
      }
    },
  );

  it.each([1, 2, 3])(
    'round %i: a join while the seat frees — waiting then offered, or refused with the slot free',
    async () => {
      const id = await court();
      const slot = at(day(11), 10);
      const held = await f.book(s.alice, s.homeA.id, id, slot);
      const x = await someone();
      const [joined, cancelled] = await Promise.all([
        wait(x.who, x.unitId, id, slot),
        f.cancel(s.alice, held.id),
      ]);
      expect(cancelled.status).toBe(204);
      const entries = await f.inTx(s.c, (tx) =>
        tx.bookingWaitlistEntry.findMany({
          where: { facilityId: id, startsAt: slot },
        }),
      );
      if (joined.status === 201) {
        // Joined first: the cancel that followed offered it the seat.
        expect(entries).toHaveLength(1);
        expect(entries[0].status).toBe('offered');
      } else {
        expect(joined.status).toBe(409);
        expect(err(joined).code).toBe('BOOKING_SLOT_AVAILABLE');
        expect(entries).toHaveLength(0);
      }
      expect(await f.holding(s.c, id)).toBe(0);
    },
  );
});
