import { BOOKING_REMINDER_SWEEP } from '../../src/facilities/bookings/booking-reminders';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { facilitiesHelpers, type FacilitiesSetUp } from '../setup/facilities';

const MINUTE = 60_000;

describe('Bookings: the reminder two hours before (ADR 0044)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let court: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    // No cancellation cutoff: a booking an hour away may still be cancelled.
    court = await f.facility(s.c, s.manager, {
      capacity: 50,
      weeklyQuota: 20,
      cancelCutoffMinutes: 0,
    });
  }, 180_000);

  afterAll(() => h.close());

  /** A booking of Bob's starting in `inMinutes`, made `madeAgo` minutes ago. */
  async function booking(
    inMinutes: number,
    madeAgo: number,
    status: 'confirmed' | 'pending' = 'confirmed',
  ) {
    return f.rawBooking(s.c, {
      facilityId: court,
      unitId: s.homeB.id,
      bookedById: s.bob.id,
      startsAt: new Date(Date.now() + inMinutes * MINUTE),
      status,
      createdAt: new Date(Date.now() - madeAgo * MINUTE),
    });
  }
  const reminded = async (id: string) =>
    (await f.notifications(s.c, s.bob.id, 'booking.reminder')).filter(
      (n) => n.targetId === id,
    ).length;

  it('a confirmed booking is reminded once in the two hours before it, if made two hours before; never twice', async () => {
    const due = await booking(90, 300);
    const later = await booking(150, 300);
    // Made 100 minutes before its start: less than two hours.
    const lastMinute = await booking(90, 10);
    const waiting = await booking(90, 300, 'pending');
    await f.sweep(BOOKING_REMINDER_SWEEP);
    await f.sweep(BOOKING_REMINDER_SWEEP);
    expect(await reminded(due)).toBe(1);
    expect((await f.row(s.c, due)).remindedAt).not.toBeNull();
    expect(await reminded(later)).toBe(0);
    expect(await reminded(lastMinute)).toBe(0);
    expect(await reminded(waiting)).toBe(0);
    // Its time comes.
    await f.sweep(BOOKING_REMINDER_SWEEP, new Date(Date.now() + 40 * MINUTE));
    expect(await reminded(later)).toBe(1);
  });

  it('a booking cancelled before its reminder is not reminded', async () => {
    const id = await booking(60, 300);
    await f.cancel(s.bob, id).expect(204);
    await f.sweep(BOOKING_REMINDER_SWEEP);
    expect(await reminded(id)).toBe(0);
  });

  it('two sweeps at once remind once', async () => {
    const ids = [await booking(100, 300), await booking(110, 300)];
    await Promise.all([
      f.sweep(BOOKING_REMINDER_SWEEP),
      f.sweep(BOOKING_REMINDER_SWEEP),
    ]);
    for (const id of ids) expect(await reminded(id)).toBe(1);
  });
});
