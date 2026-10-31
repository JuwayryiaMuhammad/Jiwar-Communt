import { newId } from '../../src/core/common/uuid';
import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

interface Place {
  facilityId: string;
  startsAt: string;
  companion: { id: string; status: string; via: string };
}

/**
 * ADR 0070: a booker brings companions — one of the household, invited and
 * accepting, or anyone of the compound by the booking's share link, which
 * shows the facility and the time, never the booker. A companion holds a
 * seat from the invite: guests and companions stay within max_guests, and a
 * slot counted in people takes them. Joining is refused to the booker, to
 * a banned account and while the unit is suspended; a companion leaves, the
 * booker removes one with a code, and a cancelled booking tells them.
 */
describe('Bookings: companions (ADR 0070)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let hall: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    // A slot counted in people: four, with up to two guests each.
    hall = await f.facility(s.c, s.manager, {
      capacity: 4,
      capacityUnit: 'people',
      maxGuests: 2,
      weeklyQuota: 20,
    });
  }, 180_000);

  afterAll(() => h.close());

  const link = async (as: Who, bookingId: string) =>
    (
      (
        await f
          .http('post', `/bookings/${bookingId}/share-link`, as.token)
          .expect(201)
      ).body as { token: string }
    ).token;
  const join = (as: Who, token: string) =>
    f.http('post', '/booking-invites/accept', as.token, { token });
  const invite = (as: Who, bookingId: string, memberId: string) =>
    f.http('post', `/bookings/${bookingId}/companions`, as.token, { memberId });
  const companions = async (bookingId: string) =>
    (await f.row(s.c, bookingId)).companions;
  /** A booking that ended holds no live place, and its seats say so. */
  const noLiveSeats = async (bookingId: string) => {
    const [row, live] = await Promise.all([
      f.row(s.c, bookingId),
      f.inTx(s.c, (tx) =>
        tx.bookingCompanion.count({
          where: { bookingId, status: { in: ['invited', 'accepted'] } },
        }),
      ),
    ]);
    expect(row.status).not.toBe('confirmed');
    expect(live).toBe(0);
    expect(row.companions).toBe(live);
  };

  it('a household invitation holds a seat; accepted, declined or removed', async () => {
    const kid = await f.family(s.c, s.homeA.id, s.alice);
    const b = await f.book(s.alice, s.homeA.id, hall, at(day(3), 10));
    const invited = (await invite(s.alice, b.id, kid.memberId).expect(201))
      .body as Place;
    expect(invited.companion).toMatchObject({
      status: 'invited',
      via: 'household',
    });
    expect(await companions(b.id)).toBe(1);
    expect(
      await f.notifications(s.c, kid.id, 'booking.companion_invited'),
    ).toHaveLength(1);
    const accepted = (
      await f
        .http(
          'post',
          `/me/companion-bookings/${invited.companion.id}/accept`,
          kid.token,
        )
        .expect(200)
    ).body as Place;
    expect(accepted.companion.status).toBe('accepted');
    await f
      .http(
        'delete',
        `/bookings/${b.id}/companions/${invited.companion.id}?reasonCode=party_changed`,
        s.alice.token,
      )
      .expect(200);
    expect(await companions(b.id)).toBe(0);
    // Not one of the household: refused.
    const other = await invite(s.alice, b.id, newId());
    expect(other.status).toBe(400);
  });

  it('by the link: shows the facility and the time, never the booker; joined at once', async () => {
    const b = await f.book(s.alice, s.homeA.id, hall, at(day(4), 10));
    const token = await link(s.alice, b.id);
    const preview = (
      await f
        .http('post', '/booking-invites/preview', s.bob.token, { token })
        .expect(200)
    ).body as Record<string, unknown>;
    expect(Object.keys(preview).sort()).toEqual([
      'endsAt',
      'facilityId',
      'facilityNameAr',
      'facilityNameEn',
      'startsAt',
    ]);
    const joined = (await join(s.bob, token).expect(201)).body as Place;
    expect(joined.companion).toMatchObject({ status: 'accepted', via: 'link' });
    expect(err(await join(s.bob, token))).toMatchObject({
      code: 'COMPANION_EXISTS',
    });
    expect(err(await join(s.alice, token)).code).toBe('COMPANION_IS_BOOKER');
    // A new link: the old one stops working.
    await link(s.alice, b.id);
    const stale = await join(await f.owner(s.c, s.homeB.id), token);
    expect(stale.status).toBe(404);
    expect(err(stale).code).toBe('BOOKING_INVITE_INVALID');
    // Leaving frees the seat.
    await f
      .http('post', `/bookings/${b.id}/companions/me/leave`, s.bob.token)
      .expect(200);
    expect(await companions(b.id)).toBe(0);
  });

  it('guests and companions stay within max_guests; a slot in people needs room', async () => {
    const b = await f.book(s.alice, s.homeA.id, hall, at(day(5), 10), {
      guests: 2,
    });
    const full = await join(s.bob, await link(s.alice, b.id));
    expect(full.status).toBe(409);
    expect(err(full)).toMatchObject({
      code: 'BOOKING_PARTY_FULL',
      params: { max: 2 },
    });
    // Four seats: Alice with one guest, Bob with one guest — no room left.
    const a = await f.book(s.alice, s.homeA.id, hall, at(day(6), 10), {
      guests: 1,
    });
    await f.book(s.bob, s.homeB.id, hall, at(day(6), 10), { guests: 1 });
    const someone = await f.owner(s.c, (await f.unit(s.c, 'A')).id);
    const noRoom = await join(someone, await link(s.alice, a.id));
    expect(noRoom.status).toBe(409);
    expect(err(noRoom).code).toBe('BOOKING_SLOT_FULL');
  });

  it('a banned account does not join; a cancelled booking tells its companions', async () => {
    const b = await f.book(s.alice, s.homeA.id, hall, at(day(7), 10));
    const token = await link(s.alice, b.id);
    const banned = await f.owner(s.c, (await f.unit(s.c, 'A')).id);
    await f
      .http('post', '/staff/facility-bans', s.handler.token, {
        accountId: banned.id,
        reasonCode: 'damage',
      })
      .expect(201);
    const refused = await join(banned, token);
    expect(refused.status).toBe(403);
    expect(err(refused).code).toBe('FACILITY_BANNED');
    const guest = await f.owner(s.c, (await f.unit(s.c, 'A')).id);
    await join(guest, token).expect(201);
    await f.cancel(s.alice, b.id).expect(204);
    expect(
      await f.notifications(s.c, guest.id, 'booking.companion_cancelled'),
    ).toHaveLength(1);
  });

  it.each([1, 2, 3])(
    'round %i: two joins race for the last seat — one wins',
    async () => {
      const room = await f.facility(s.c, s.manager, {
        nameEn: 'Room',
        capacity: 2,
        capacityUnit: 'people',
        maxGuests: 3,
        weeklyQuota: 20,
      });
      const b = await f.book(s.alice, s.homeA.id, room, at(day(8), 10));
      const token = await link(s.alice, b.id);
      const [x, y] = [
        await f.owner(s.c, (await f.unit(s.c, 'A')).id),
        await f.owner(s.c, (await f.unit(s.c, 'A')).id),
      ];
      const results = await Promise.all([join(x, token), join(y, token)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await companions(b.id)).toBe(1);
    },
  );

  it.each([1, 2, 3])(
    'round %i: a join and the booking’s cancel at once — never a seat on a cancelled booking',
    async () => {
      const b = await f.book(s.alice, s.homeA.id, hall, at(day(9), 10));
      const token = await link(s.alice, b.id);
      const x = await f.owner(s.c, (await f.unit(s.c, 'A')).id);
      const [joined, cancelled] = await Promise.all([
        join(x, token),
        f.cancel(s.alice, b.id),
      ]);
      // The cancel always wins its own way: a join never blocks it.
      expect(cancelled.status).toBe(204);
      if (joined.status === 201)
        expect(
          await f.notifications(s.c, x.id, 'booking.companion_cancelled'),
        ).toHaveLength(1);
      // Refused: the link was dead when read (404), or the booking was
      // cancelled by the time the join held its locks (409).
      else if (joined.status === 404)
        expect(err(joined).code).toBe('BOOKING_INVITE_INVALID');
      else
        expect(err(joined)).toMatchObject({
          code: 'BOOKING_INVALID_TRANSITION',
          params: { status: 'cancelled' },
        });
      await noLiveSeats(b.id);
    },
  );

  it.each([1, 2, 3])(
    'round %i: an invitee accepts while a ban of them lands — accepted before it, or refused after it; the seat held either way',
    async (round) => {
      const home = await f.unit(s.c, 'A');
      const primary = await f.owner(s.c, home.id);
      const kid = await f.family(s.c, home.id, primary);
      // A slot of its own each round.
      const b = await f.book(primary, home.id, hall, at(day(10 + round), 10));
      const invited = (await invite(primary, b.id, kid.memberId).expect(201))
        .body as Place;
      const [accepted, banned] = await Promise.all([
        f.http(
          'post',
          `/me/companion-bookings/${invited.companion.id}/accept`,
          kid.token,
        ),
        f.http('post', '/staff/facility-bans', s.handler.token, {
          accountId: kid.id,
          reasonCode: 'damage',
        }),
      ]);
      expect(banned.status).toBe(201);
      const row = await f.inTx(s.c, (tx) =>
        tx.bookingCompanion.findUniqueOrThrow({
          where: { id: invited.companion.id },
        }),
      );
      if (accepted.status === 200) expect(row.status).toBe('accepted');
      else {
        expect(accepted.status).toBe(403);
        expect(err(accepted).code).toBe('FACILITY_BANNED');
        expect(row.status).toBe('invited');
      }
      expect(await companions(b.id)).toBe(1);
    },
  );

  it('the staff’s cancel and a ban end the companions’ places and tell them, the seats back to 0', async () => {
    const kid = await f.family(s.c, s.homeA.id, s.alice);
    const b = await f.book(s.alice, s.homeA.id, hall, at(day(8), 12));
    await invite(s.alice, b.id, kid.memberId).expect(201);
    await join(s.bob, await link(s.alice, b.id)).expect(201);
    expect(await companions(b.id)).toBe(2);
    await f
      .http('post', `/staff/bookings/${b.id}/cancel`, s.handler.token, {
        reasonCode: 'facility_unavailable',
      })
      .expect(204);
    await noLiveSeats(b.id);
    for (const who of [kid.id, s.bob.id])
      expect(
        (await f.notifications(s.c, who, 'booking.companion_cancelled')).map(
          (n) => n.params,
        ),
      ).toContainEqual({});
    // A ban cancels as the staff do (ADR 0067): its companions too.
    const home = await f.unit(s.c, 'A');
    const banned = await f.owner(s.c, home.id);
    const nb = await f.book(banned, home.id, hall, at(day(8), 14));
    await join(s.bob, await link(banned, nb.id)).expect(201);
    await f
      .http('post', '/staff/facility-bans', s.handler.token, {
        accountId: banned.id,
        reasonCode: 'damage',
      })
      .expect(201);
    await noLiveSeats(nb.id);
  });

  it('a closure ends the companions’ places of what it cancels, the seats back to 0', async () => {
    const b = await f.book(s.alice, s.homeA.id, hall, at(day(8), 16));
    await join(s.bob, await link(s.alice, b.id)).expect(201);
    await f
      .http('post', `/staff/facilities/${hall}/closures`, s.manager.token, {
        startsAt: at(day(8), 16).toISOString(),
        endsAt: at(day(8), 18).toISOString(),
        reasonCode: 'maintenance',
      })
      .expect(201);
    await noLiveSeats(b.id);
    const row = await f.inTx(s.c, (tx) =>
      tx.bookingCompanion.findFirstOrThrow({ where: { bookingId: b.id } }),
    );
    expect(row).toMatchObject({
      status: 'cancelled',
      endedAt: expect.any(Date) as Date,
    });
  });
});
