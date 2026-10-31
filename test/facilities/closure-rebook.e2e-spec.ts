import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
} from '../setup/facilities';

const HOUR = 3_600_000;

/**
 * ADR 0070: a booking a closure cancelled may be rebooked once, at the same
 * facility, within 72 hours of the cancel — the unit's weekly and peak
 * quotas skipped that once.
 */
describe('Bookings: priority rebook after a closure (ADR 0070)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
  }, 180_000);

  afterAll(() => h.close());

  /** A court of one booking a week, booked and closed over: the cancelled booking. */
  async function closedOver(dayN: number) {
    const court = await f.facility(s.c, s.manager, {
      weeklyQuota: 1,
      capacity: 3,
    });
    const b = await f.book(s.alice, s.homeA.id, court, at(day(dayN), 10));
    await f
      .http('post', `/staff/facilities/${court}/closures`, s.manager.token, {
        startsAt: at(day(dayN), 9).toISOString(),
        endsAt: at(day(dayN), 12).toISOString(),
        reasonCode: 'maintenance',
      })
      .expect(201);
    return { court, booking: await f.row(s.c, b.id) };
  }

  it('cancelled by a closure: rebookable for 72 hours, past the quota, once', async () => {
    const { court, booking } = await closedOver(3);
    expect(
      booking.rebookUntil!.getTime() - booking.cancelledAt!.getTime(),
    ).toBe(72 * HOUR);
    // The week's quota is used: a plain booking is refused, the rebook not.
    await f.book(s.alice, s.homeA.id, court, at(day(4), 10));
    const plain = await f.bookRaw(s.alice, s.homeA.id, court, at(day(5), 10));
    expect(err(plain).code).toBe('BOOKING_QUOTA_REACHED');
    const again = await f.book(s.alice, s.homeA.id, court, at(day(5), 10), {
      rebookOf: booking.id,
    });
    expect((await f.row(s.c, again.id)).rebookOfId).toBe(booking.id);
    const twice = await f.bookRaw(s.alice, s.homeA.id, court, at(day(6), 10), {
      rebookOf: booking.id,
    });
    expect(err(twice)).toMatchObject({
      code: 'REBOOK_NOT_ALLOWED',
      params: { reason: 'rebooked' },
    });
  });

  it('only at the same facility, only what a closure cancelled', async () => {
    const { booking } = await closedOver(7);
    const other = await f.facility(s.c, s.manager, { weeklyQuota: 5 });
    const elsewhere = await f.bookRaw(
      s.alice,
      s.homeA.id,
      other,
      at(day(8), 10),
      { rebookOf: booking.id },
    );
    expect(err(elsewhere).params).toEqual({ reason: 'other_facility' });
    const kept = await f.book(s.alice, s.homeA.id, other, at(day(9), 10));
    await f.cancel(s.alice, kept.id).expect(204);
    const plain = await f.bookRaw(s.alice, s.homeA.id, other, at(day(10), 10), {
      rebookOf: kept.id,
    });
    expect(err(plain).params).toEqual({ reason: 'not_closed' });
  });

  it.each([1, 2, 3])(
    'round %i: two rebooks of one booking at once — one booking',
    async () => {
      const { court, booking } = await closedOver(11);
      const both = await Promise.all([
        f.bookRaw(s.alice, s.homeA.id, court, at(day(12), 10), {
          rebookOf: booking.id,
        }),
        f.bookRaw(s.alice, s.homeA.id, court, at(day(12), 11), {
          rebookOf: booking.id,
        }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    },
  );
});
