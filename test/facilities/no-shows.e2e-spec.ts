import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

const HOUR = 3_600_000;

describe('Bookings: no-shows and suspensions (ADR 0044)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let court: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    court = await f.facility(s.c, s.manager, { weeklyQuota: 20, capacity: 10 });
  }, 180_000);

  afterAll(() => h.close());

  /** A confirmed booking of the unit whose slot ended `hoursAgo` hours ago. */
  const ended = (unitId: string, by: Who, hoursAgo = 1) =>
    f.rawBooking(s.c, {
      facilityId: court,
      unitId,
      bookedById: by.id,
      startsAt: new Date(Date.now() - (hoursAgo + 1) * HOUR),
    });
  const noShow = (id: string, as: Who = s.handler) =>
    f.http('post', `/staff/bookings/${id}/no-show`, as.token);
  const standing = async (who: Who, unitId: string) =>
    (
      (
        await f
          .http('get', `/units/${unitId}/booking-standing`, who.token)
          .expect(200)
      ).body as { suspension: { id: string; endsAt: string } | null }
    ).suspension;

  it('a no-show is marked after the slot, within three days, on a confirmed booking only; final', async () => {
    const future = await f.book(s.alice, s.homeA.id, court, at(day(2), 10));
    expect((await noShow(future.id).expect(409)).body).toMatchObject({
      code: 'BOOKING_NOT_OVER',
    });
    const old = await ended(s.homeA.id, s.alice, 73);
    expect((await noShow(old).expect(409)).body).toMatchObject({
      code: 'BOOKING_NO_SHOW_TOO_LATE',
      params: { hours: 72 },
    });
    const recent = await ended(s.homeA.id, s.alice);
    await noShow(recent).expect(204);
    expect(await f.row(s.c, recent)).toMatchObject({
      status: 'no_show',
      noShowMarkedById: s.handler.id,
    });
    expect((await noShow(recent).expect(409)).body).toMatchObject({
      code: 'BOOKING_INVALID_TRANSITION',
      params: { status: 'no_show' },
    });
  });

  it('three no-shows in thirty days suspend the unit for fourteen days: its people are told and see the end; new bookings are refused, held ones stay', async () => {
    const unit = await f.unit(s.c, 'N');
    const owner = await f.owner(s.c, unit.id);
    const member = await f.family(s.c, unit.id, owner);
    const held = await f.book(owner, unit.id, court, at(day(3), 10));
    const ids = [
      await ended(unit.id, owner),
      await ended(unit.id, member, 2),
      await ended(unit.id, owner, 3),
    ];
    await noShow(ids[0]).expect(204);
    await noShow(ids[1]).expect(204);
    expect(await standing(owner, unit.id)).toBeNull();
    await noShow(ids[2]).expect(204);

    const suspension = (await standing(member, unit.id))!;
    expect(suspension).not.toBeNull();
    const days =
      (new Date(suspension.endsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    for (const who of [owner, member])
      expect(
        await f.notifications(s.c, who.id, 'booking_suspension.started'),
      ).toHaveLength(1);

    const refused = await f.bookRaw(member, unit.id, court, at(day(4), 10));
    expect([refused.status, refused.body]).toMatchObject([
      403,
      { code: 'BOOKINGS_SUSPENDED', params: { until: suspension.endsAt } },
    ]);
    expect((await f.row(s.c, held.id)).status).toBe('confirmed');
    // Another unit books on.
    await f.book(s.bob, s.homeB.id, court, at(day(4), 10));
  });

  it('a no-show while suspended starts nothing new; after a lift, only no-shows marked since it began count', async () => {
    const unit = await f.unit(s.c, 'N');
    const owner = await f.owner(s.c, unit.id);
    for (let i = 1; i <= 4; i++)
      await noShow(await ended(unit.id, owner, i)).expect(204);
    const rows = await f.inTx(s.c, (tx) =>
      tx.bookingSuspension.findMany({ where: { unitId: unit.id } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].noShowCount).toBe(3);

    await f
      .http(
        'post',
        `/staff/booking-suspensions/${rows[0].id}/lift`,
        s.handler.token,
        {
          reasonCode: 'exception_granted',
        },
      )
      .expect(204);
    expect(await standing(owner, unit.id)).toBeNull();
    await f.book(owner, unit.id, court, at(day(5), 10));
    const again = await f
      .http(
        'post',
        `/staff/booking-suspensions/${rows[0].id}/lift`,
        s.handler.token,
        {
          reasonCode: 'other',
        },
      )
      .expect(409);
    expect(again.body).toMatchObject({
      code: 'BOOKING_SUSPENSION_NOT_IN_FORCE',
    });
    // Only no-shows marked since the suspension began count: the fourth
    // (marked while it was in force) and one more are two, not three.
    await noShow(await ended(unit.id, owner, 5)).expect(204);
    expect(await standing(owner, unit.id)).toBeNull();
    await noShow(await ended(unit.id, owner, 6)).expect(204);
    expect(await standing(owner, unit.id)).not.toBeNull();
  });

  it('the rules are the compound’s settings', async () => {
    const res = await f
      .http('patch', '/staff/facility-settings', s.manager.token, {
        noShowThreshold: 1,
        suspensionDays: 2,
      })
      .expect(200);
    expect(res.body).toEqual({
      noShowThreshold: 1,
      noShowWindowDays: 30,
      suspensionDays: 2,
    });
    try {
      const unit = await f.unit(s.c, 'N');
      const owner = await f.owner(s.c, unit.id);
      await noShow(await ended(unit.id, owner)).expect(204);
      const suspension = (await standing(owner, unit.id))!;
      const days =
        (new Date(suspension.endsAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(1.9);
      expect(days).toBeLessThanOrEqual(2);
    } finally {
      await f
        .http('patch', '/staff/facility-settings', s.manager.token, {
          noShowThreshold: 3,
          suspensionDays: 14,
        })
        .expect(200);
    }
  });

  it('the staff list suspensions with the unit’s code; residents read only their own unit’s standing', async () => {
    const list = (
      await f
        .http('get', '/staff/booking-suspensions?inForce=true', s.handler.token)
        .expect(200)
    ).body as { data: { unitCode: string; liftedAt: string | null }[] };
    expect(list.data.length).toBeGreaterThan(0);
    expect(list.data.every((x) => x.liftedAt === null && x.unitCode)).toBe(
      true,
    );
    await f
      .http('get', `/units/${s.homeA.id}/booking-standing`, s.bob.token)
      .expect(404);
    await f
      .http('get', '/staff/booking-suspensions', s.alice.token)
      .expect(403);
  });

  describe('under concurrency', () => {
    it('the no-show that suspends the unit and a booking at once: the booking is decided before it or refused after it', async () => {
      for (let round = 0; round < 3; round++) {
        const unit = await f.unit(s.c, 'N');
        const owner = await f.owner(s.c, unit.id);
        await noShow(await ended(unit.id, owner, 1)).expect(204);
        await noShow(await ended(unit.id, owner, 2)).expect(204);
        const third = await ended(unit.id, owner, 3);
        const [mark, booking] = await Promise.all([
          noShow(third),
          f.bookRaw(owner, unit.id, court, at(day(6), 6 + round)),
        ]);
        expect(mark.status).toBe(204);
        expect([201, 403]).toContain(booking.status);
        const suspension = await f.inTx(s.c, (tx) =>
          tx.bookingSuspension.findFirstOrThrow({ where: { unitId: unit.id } }),
        );
        if (booking.status === 201) {
          const made = await f.row(s.c, (booking.body as { id: string }).id);
          expect(made.createdAt.getTime()).toBeLessThanOrEqual(
            suspension.startsAt.getTime(),
          );
        } else
          expect(booking.body).toMatchObject({ code: 'BOOKINGS_SUSPENDED' });
      }
    });

    it('two no-shows reaching the threshold at once start one suspension', async () => {
      const unit = await f.unit(s.c, 'N');
      const owner = await f.owner(s.c, unit.id);
      await noShow(await ended(unit.id, owner, 1)).expect(204);
      const [a, b] = [
        await ended(unit.id, owner, 2),
        await ended(unit.id, owner, 3),
      ];
      const results = await Promise.all([noShow(a), noShow(b, s.manager)]);
      expect(results.map((r) => r.status)).toEqual([204, 204]);
      expect(
        await f.inTx(s.c, (tx) =>
          tx.bookingSuspension.count({ where: { unitId: unit.id } }),
        ),
      ).toBe(1);
    });
  });
});
