import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

interface Stay {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  stayFromOn: string;
  stayToOn: string;
  charge: { amount: string } | null;
}

/**
 * ADR 0070: overnight guest rooms. A stay facility is booked by the night,
 * confirmed at once, from the check-in on the first night to the check-out
 * on the last day, in the compound's time zone; a night is full when its
 * rooms are taken. No slots, companions or waitlist; a closure cancels the
 * stays it overlaps; a fee is per night.
 */
describe('Bookings: stays (ADR 0070)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
  }, 180_000);

  afterAll(() => h.close());

  /** A guest room facility: one room by default, check-in 14:00, out 12:00. */
  const rooms = async (over: Record<string, unknown> = {}) =>
    (
      (
        await f
          .http('post', '/staff/facilities', s.manager.token, {
            mode: 'stay',
            nameEn: 'Guest room',
            nameAr: 'غرفة ضيوف',
            capacity: 1,
            checkInTime: '14:00',
            checkOutTime: '12:00',
            maxNights: 3,
            weeklyQuota: 20,
            ...over,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  const stay = (
    as: Who,
    unitId: string,
    facilityId: string,
    fromOn: string,
    toOn: string,
  ) =>
    f.http('post', `/units/${unitId}/stays`, as.token, {
      facilityId,
      fromOn,
      toOn,
    });
  const someone = async () => {
    const home = await f.unit(s.c, 'A');
    return { who: await f.owner(s.c, home.id), unitId: home.id };
  };

  it('nights from check-in to check-out; a full night is refused, the next guest arrives on the check-out day', async () => {
    const id = await rooms();
    const first = (
      await stay(s.alice, s.homeA.id, id, day(3), day(5)).expect(201)
    ).body as Stay;
    expect(first).toMatchObject({
      status: 'confirmed',
      stayFromOn: day(3),
      stayToOn: day(5),
      startsAt: at(day(3), 14).toISOString(),
      endsAt: at(day(5), 12).toISOString(),
    });
    const full = await stay(s.bob, s.homeB.id, id, day(4), day(6));
    expect(full.status).toBe(409);
    expect(err(full)).toMatchObject({
      code: 'STAY_NIGHT_FULL',
      params: { nightOn: day(4) },
    });
    await stay(s.bob, s.homeB.id, id, day(5), day(6)).expect(201);
  });

  it('at most maxNights; not booked by slot, and takes no companions or waitlist', async () => {
    const id = await rooms();
    const long = await stay(s.alice, s.homeA.id, id, day(3), day(8));
    expect(long.status).toBe(400);
    expect(err(long).fields).toEqual([
      { field: 'toOn', code: 'STAY_TOO_LONG', params: { max: 3 } },
    ]);
    const slot = await f.bookRaw(s.alice, s.homeA.id, id, at(day(3), 10));
    expect(err(slot).code).toBe('FACILITY_NOT_BOOKABLE');
    const b = (await stay(s.alice, s.homeA.id, id, day(9), day(10)).expect(201))
      .body as Stay;
    const link = await f.http(
      'post',
      `/bookings/${b.id}/share-link`,
      s.alice.token,
    );
    expect(err(link).code).toBe('FACILITY_NOT_BOOKABLE');
    const wait = await f.http(
      'post',
      `/facilities/${id}/waitlist`,
      s.bob.token,
      {
        unitId: s.homeB.id,
        startsAt: b.startsAt,
      },
    );
    expect(err(wait).code).toBe('FACILITY_NOT_BOOKABLE');
  });

  it('a fee is owed per night; a closure cancels the stays it overlaps', async () => {
    const id = await rooms({ feeAmount: '100.00', capacity: 2 });
    const b = (
      await stay(s.alice, s.homeA.id, id, day(11), day(13)).expect(201)
    ).body as Stay;
    expect(b.charge?.amount).toBe('200.00');
    const window = {
      startsAt: at(day(12), 9).toISOString(),
      endsAt: at(day(12), 18).toISOString(),
    };
    // A fee at stake: previewed first (ADR 0084).
    const { previewToken } = (
      await f
        .http(
          'get',
          `/staff/facilities/${id}/closure-preview?${new URLSearchParams(window).toString()}`,
          s.manager.token,
        )
        .expect(200)
    ).body as { previewToken: string };
    await f
      .http('post', `/staff/facilities/${id}/closures`, s.manager.token, {
        ...window,
        reasonCode: 'maintenance',
        previewToken,
      })
      .expect(201);
    expect((await f.row(s.c, b.id)).status).toBe('cancelled');
  });

  it.each([1, 2, 3])(
    'round %i: two overlapping stays for the last room, nights in either order — one wins, no deadlock',
    async () => {
      const id = await rooms();
      const [x, y] = [await someone(), await someone()];
      const both = await Promise.all([
        stay(x.who, x.unitId, id, day(3), day(5)),
        stay(y.who, y.unitId, id, day(4), day(6)),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      const refused = both.find((r) => r.status === 409)!;
      expect(err(refused).code).toBe('STAY_NIGHT_FULL');
    },
  );

  it.each([1, 2, 3])(
    'round %i: a stay and a closure over it at once — never a confirmed stay in a closure',
    async () => {
      const id = await rooms();
      const x = await someone();
      const [booked, closed] = await Promise.all([
        stay(x.who, x.unitId, id, day(6), day(7)),
        f.http('post', `/staff/facilities/${id}/closures`, s.manager.token, {
          startsAt: at(day(6), 9).toISOString(),
          endsAt: at(day(7), 18).toISOString(),
          reasonCode: 'maintenance',
        }),
      ]);
      expect(closed.status).toBe(201);
      if (booked.status === 201)
        expect((await f.row(s.c, (booked.body as Stay).id)).status).toBe(
          'cancelled',
        );
      else expect(err(booked).code).toBe('FACILITY_CLOSED');
    },
  );
});
