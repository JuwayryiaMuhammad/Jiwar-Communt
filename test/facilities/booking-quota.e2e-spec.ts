import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

/**
 * ADR 0044: a unit holds at most `weeklyQuota` bookings at a facility in
 * any 7 days (pending, confirmed and no-shows; past ones too) and at most
 * `peakQuota` peak ones. The quota is the unit's, whoever of its people
 * books; it is counted under the unit's lock, so bookings arriving at once
 * are decided one at a time.
 */
describe('Bookings — a unit’s quota', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let member: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    member = await f.family(s.c, s.homeA.id, s.alice);
  }, 180_000);

  afterAll(() => h.close());

  const codes = (results: { status: number; body: unknown }[]) =>
    results
      .map((r) =>
        `${r.status} ${(r.body as { code?: string }).code ?? ''}`.trim(),
      )
      .sort();
  const peaksAllWeek = (id: string) =>
    f
      .http('put', `/staff/facilities/${id}/peak-windows`, s.manager.token, {
        windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMinute: 1080,
          endMinute: 1260,
        })),
      })
      .expect(200);

  it('two a week by default: the third within any 7 days is refused, a later week is not', async () => {
    const court = await f.facility(s.c, s.manager);
    await f.book(s.alice, s.homeA.id, court, at(day(2), 10));
    await f.book(member, s.homeA.id, court, at(day(3), 10));
    const third = await f.bookRaw(s.alice, s.homeA.id, court, at(day(4), 10));
    expect([third.status, third.body]).toMatchObject([
      409,
      { code: 'BOOKING_QUOTA_REACHED', params: { quota: 2, peak: false } },
    ]);
    // Day 9 shares no 7 days with both: [day 3, day 10) holds two.
    await f.book(s.alice, s.homeA.id, court, at(day(9), 10));
    // Another unit has its own quota.
    await f.book(s.bob, s.homeB.id, court, at(day(4), 10));
  });

  it('a cancelled booking gives its place in the quota back; a no-show keeps it', async () => {
    const court = await f.facility(s.c, s.manager);
    const a = await f.book(s.alice, s.homeA.id, court, at(day(2), 10));
    const b = await f.book(s.alice, s.homeA.id, court, at(day(2), 12));
    await f.cancel(s.alice, a.id).expect(204);
    await f.book(s.alice, s.homeA.id, court, at(day(3), 10));
    await f.inTx(s.c, (tx) =>
      tx.booking.update({
        where: { id: b.id },
        data: {
          status: 'no_show',
          noShowMarkedAt: new Date(),
          noShowMarkedById: s.manager.id,
        },
      }),
    );
    const res = await f.bookRaw(s.alice, s.homeA.id, court, at(day(4), 10));
    expect(res.status).toBe(409);
  });

  it('peak times have their own quota, one by default', async () => {
    const court = await f.facility(s.c, s.manager);
    await peaksAllWeek(court);
    await f.book(s.alice, s.homeA.id, court, at(day(2), 18));
    const peak = await f.bookRaw(s.alice, s.homeA.id, court, at(day(3), 19));
    expect([peak.status, peak.body]).toMatchObject([
      409,
      { code: 'BOOKING_QUOTA_REACHED', params: { quota: 1, peak: true } },
    ]);
    // An off-peak slot still fits the weekly quota.
    await f.book(s.alice, s.homeA.id, court, at(day(3), 10));
  });

  describe('under concurrency', () => {
    it('six slots of one week at once, by two of the unit’s people: exactly two are booked', async () => {
      const court = await f.facility(s.c, s.manager);
      const results = await Promise.all(
        [10, 11, 12, 13, 14, 15].map((hour, i) =>
          f.bookRaw(
            i % 2 ? member : s.alice,
            s.homeA.id,
            court,
            at(day(5), hour),
          ),
        ),
      );
      expect(codes(results)).toEqual([
        '201',
        '201',
        '409 BOOKING_QUOTA_REACHED',
        '409 BOOKING_QUOTA_REACHED',
        '409 BOOKING_QUOTA_REACHED',
        '409 BOOKING_QUOTA_REACHED',
      ]);
      expect(await f.holding(s.c, court)).toBe(2);
    });

    it('three peak slots at once: exactly one is booked', async () => {
      const court = await f.facility(s.c, s.manager, { capacity: 5 });
      await peaksAllWeek(court);
      const results = await Promise.all(
        [18, 19, 20].map((hour, i) =>
          f.bookRaw(
            i % 2 ? member : s.alice,
            s.homeA.id,
            court,
            at(day(6), hour),
          ),
        ),
      );
      expect(codes(results)).toEqual([
        '201',
        '409 BOOKING_QUOTA_REACHED',
        '409 BOOKING_QUOTA_REACHED',
      ]);
    });

    it('two of the unit’s people book the same slot at once: the unit holds it once', async () => {
      const court = await f.facility(s.c, s.manager, { capacity: 5 });
      const results = await Promise.all([
        f.bookRaw(s.alice, s.homeA.id, court, at(day(7), 10)),
        f.bookRaw(member, s.homeA.id, court, at(day(7), 10)),
      ]);
      expect(codes(results)).toEqual(['201', '409 BOOKING_ALREADY_HELD']);
    });
  });
});
