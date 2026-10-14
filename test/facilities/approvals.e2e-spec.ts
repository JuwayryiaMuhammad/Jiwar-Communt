import { BOOKING_EXPIRE_SWEEP } from '../../src/facilities/bookings/staff-bookings.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
} from '../setup/facilities';

interface StaffBookingBody {
  id: string;
  unitCode: string;
  bookedBy: { id: string; fullName: string | null; erased: boolean };
  status: string;
  partySize: number;
}

describe('Bookings: the staff decide and cancel (ADR 0044)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let hall: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    hall = await f.facility(s.c, s.manager, {
      requiresApproval: true,
      capacity: 2,
      weeklyQuota: 20,
    });
  }, 180_000);

  afterAll(() => h.close());

  const kinds = async (accountId: string) =>
    (await f.notifications(s.c, accountId)).map((n) => n.kind);

  it('the queue lists pending bookings with their unit and booker; a handler approves one and its booker is told', async () => {
    const b = await f.book(s.alice, s.homeA.id, hall, at(day(2), 10));
    const queue = (
      await f
        .http(
          'get',
          `/staff/bookings?status=pending&facilityId=${hall}`,
          s.handler.token,
        )
        .expect(200)
    ).body as { data: StaffBookingBody[] };
    const row = queue.data.find((x) => x.id === b.id)!;
    expect(row).toMatchObject({
      unitCode: s.homeA.code,
      bookedBy: { id: s.alice.id, erased: false },
      status: 'pending',
      partySize: 1,
    });
    expect(row.bookedBy.fullName).toEqual(expect.any(String));

    await f
      .http('post', `/staff/bookings/${b.id}/approve`, s.handler.token)
      .expect(204);
    expect(await f.row(s.c, b.id)).toMatchObject({
      status: 'confirmed',
      decidedById: s.handler.id,
    });
    expect(await kinds(s.alice.id)).toContain('booking.approved');
    const twice = await f
      .http('post', `/staff/bookings/${b.id}/approve`, s.handler.token)
      .expect(409);
    expect(twice.body).toMatchObject({
      code: 'BOOKING_INVALID_TRANSITION',
      params: { status: 'confirmed' },
    });
  });

  it('a rejection carries a reason code to the booker; nobody is told of what they did themselves', async () => {
    const b = await f.book(s.bob, s.homeB.id, hall, at(day(2), 11));
    await f
      .http('post', `/staff/bookings/${b.id}/reject`, s.handler.token, {
        reasonCode: 'nope',
      })
      .expect(400);
    await f
      .http('post', `/staff/bookings/${b.id}/reject`, s.handler.token, {
        reasonCode: 'slot_unavailable',
      })
      .expect(204);
    expect(await f.row(s.c, b.id)).toMatchObject({
      status: 'rejected',
      rejectReason: 'slot_unavailable',
    });
    const told = await f.notifications(s.c, s.bob.id, 'booking.rejected');
    expect(told.map((n) => n.params)).toEqual([
      { reason: 'slot_unavailable' },
    ]);
    expect(await kinds(s.handler.id)).toEqual([]);
  });

  it('the staff cancel a confirmed booking whatever the cutoff, until it ends', async () => {
    const strict = await f.facility(s.c, s.manager, {
      cancelCutoffMinutes: 10080,
    });
    const b = await f.book(s.alice, s.homeA.id, strict, at(day(2), 12));
    await f
      .http('post', `/staff/bookings/${b.id}/cancel`, s.handler.token, {
        reasonCode: 'facility_unavailable',
      })
      .expect(204);
    expect(await f.row(s.c, b.id)).toMatchObject({
      status: 'cancelled',
      cancelledSide: 'staff',
      cancelReason: 'facility_unavailable',
      cancelledById: s.handler.id,
    });
    expect(
      (
        await f.notifications(s.c, s.alice.id, 'booking.cancelled_by_staff')
      ).map((n) => n.params),
    ).toEqual([{ reason: 'facility_unavailable' }]);
    const over = await f.rawBooking(s.c, {
      facilityId: strict,
      unitId: s.homeA.id,
      bookedById: s.alice.id,
      startsAt: new Date(Date.now() - 2 * 3_600_000),
    });
    const late = await f
      .http('post', `/staff/bookings/${over}/cancel`, s.handler.token, {
        reasonCode: 'other',
      })
      .expect(409);
    expect(late.body).toMatchObject({ code: 'BOOKING_WINDOW_PASSED' });
  });

  it('a pending booking whose start passed is neither approved nor rejected: the sweep cancels it and tells its booker, once', async () => {
    const started = await f.rawBooking(s.c, {
      facilityId: hall,
      unitId: s.homeB.id,
      bookedById: s.bob.id,
      startsAt: new Date(Date.now() - 60_000),
      status: 'pending',
    });
    for (const action of ['approve', 'reject'])
      expect(
        (
          await f
            .http(
              'post',
              `/staff/bookings/${started}/${action}`,
              s.handler.token,
              {
                ...(action === 'reject' ? { reasonCode: 'other' } : {}),
              },
            )
            .expect(409)
        ).body,
      ).toMatchObject({ code: 'BOOKING_WINDOW_PASSED' });
    const waiting = await f.book(s.bob, s.homeB.id, hall, at(day(3), 10));
    expect(await f.sweep(BOOKING_EXPIRE_SWEEP)).toBeGreaterThanOrEqual(1);
    expect(await f.row(s.c, started)).toMatchObject({
      status: 'cancelled',
      cancelledSide: 'system',
      cancelReason: 'approval_expired',
      cancelledById: null,
    });
    // One still ahead of its start waits on.
    expect((await f.row(s.c, waiting.id)).status).toBe('pending');
    await f.sweep(BOOKING_EXPIRE_SWEEP);
    expect(
      await f.notifications(s.c, s.bob.id, 'booking.approval_expired'),
    ).toHaveLength(1);
  });

  it('an approval never exceeds the capacity as it is now: after a cut, the confirmed bookings fill it first', async () => {
    const room = await f.facility(s.c, s.manager, {
      requiresApproval: true,
      capacity: 2,
    });
    const one = await f.book(s.alice, s.homeA.id, room, at(day(4), 10));
    const two = await f.book(s.bob, s.homeB.id, room, at(day(4), 10));
    await f
      .http('patch', `/staff/facilities/${room}`, s.manager.token, {
        capacity: 1,
      })
      .expect(200);
    await f
      .http('post', `/staff/bookings/${one.id}/approve`, s.handler.token)
      .expect(204);
    const res = await f
      .http('post', `/staff/bookings/${two.id}/approve`, s.handler.token)
      .expect(409);
    expect(res.body).toMatchObject({ code: 'BOOKING_SLOT_FULL' });
  });

  it('a facility’s day: its slots with what is taken, and every booking of the day by unit and booker', async () => {
    const court = await f.facility(s.c, s.manager, { capacity: 2 });
    await f.book(s.alice, s.homeA.id, court, at(day(5), 10));
    const gone = await f.book(s.bob, s.homeB.id, court, at(day(5), 10));
    await f.cancel(s.bob, gone.id).expect(204);
    const res = await f
      .http(
        'get',
        `/staff/facilities/${court}/day?date=${day(5)}`,
        s.handler.token,
      )
      .expect(200);
    const body = res.body as {
      date: string;
      capacity: number;
      slots: { startsAt: string; taken: number }[];
      bookings: StaffBookingBody[];
    };
    expect(body.date).toBe(day(5));
    expect(body.capacity).toBe(2);
    expect(body.slots).toHaveLength(16);
    expect(
      body.slots.find((x) => x.startsAt === at(day(5), 10).toISOString())
        ?.taken,
    ).toBe(1);
    expect(body.bookings.map((b) => [b.unitCode, b.status])).toEqual([
      [s.homeA.code, 'confirmed'],
      [s.homeB.code, 'cancelled'],
    ]);
  });

  it('the handler’s routes are the handler’s: a resident and a manager of the set-up only are refused', async () => {
    const setUpOnly = await f.staff(s.c, ['facilities.manage']);
    await f.http('get', '/staff/bookings', s.alice.token).expect(403);
    await f.http('get', '/staff/bookings', setUpOnly.token).expect(403);
    await f.http('get', '/staff/bookings', s.manager.token).expect(200);
  });
});
