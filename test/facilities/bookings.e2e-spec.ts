import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type BookingBody,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

const code = (res: { body: unknown }) => (res.body as { code: string }).code;
const fields = (res: { body: unknown }) =>
  (res.body as { fields: unknown[] }).fields;

describe('Bookings: a resident books for a unit (ADR 0044)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let court: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    court = await f.facility(s.c, s.manager, { weeklyQuota: 20, peakQuota: 1 });
  }, 180_000);

  afterAll(() => h.close());

  describe('booking', () => {
    it('confirmed at once: the slot is then full for everyone, and the unit sees it as its own', async () => {
      const startsAt = at(day(2), 10);
      const b = await f.book(s.alice, s.homeA.id, court, startsAt);
      expect(b).toMatchObject({
        facilityId: court,
        unitId: s.homeA.id,
        startsAt: startsAt.toISOString(),
        endsAt: at(day(2), 11).toISOString(),
        guests: 0,
        peak: false,
        status: 'confirmed',
        mine: true,
        rejectReason: null,
        cancelReason: null,
      });
      expect(Object.keys(b).sort()).toEqual([
        'cancelReason',
        'cancelledSide',
        'createdAt',
        'endsAt',
        'facilityId',
        'guests',
        'id',
        'mine',
        'occasion',
        'peak',
        'rejectReason',
        'startsAt',
        'status',
        'unitId',
      ]);
      const forBob = await f.slots(s.bob, court, day(2), s.homeB.id);
      const slot = forBob.find((x) => x.startsAt === startsAt.toISOString())!;
      expect(slot).toEqual({
        startsAt: startsAt.toISOString(),
        endsAt: at(day(2), 11).toISOString(),
        peak: false,
        state: 'full',
        mine: false,
      });
      const forAlice = await f.slots(s.alice, court, day(2), s.homeA.id);
      expect(
        forAlice.find((x) => x.startsAt === startsAt.toISOString()),
      ).toMatchObject({ state: 'full', mine: true });
      const taken = await f.bookRaw(s.bob, s.homeB.id, court, startsAt);
      expect([taken.status, code(taken)]).toEqual([409, 'BOOKING_SLOT_FULL']);
      const again = await f.bookRaw(s.alice, s.homeA.id, court, startsAt);
      expect([again.status, code(again)]).toEqual([
        409,
        'BOOKING_ALREADY_HELD',
      ]);
    });

    it('a slot is named by its start exactly; too soon and too far are refused, and left out of the slots', async () => {
      const off = await f.bookRaw(
        s.alice,
        s.homeA.id,
        court,
        at(day(2), 10, 30),
      );
      expect(fields(off)).toEqual([
        { field: 'startsAt', code: 'BOOKING_SLOT_NOT_OFFERED' },
      ]);
      const closed = await f.bookRaw(
        s.alice,
        s.homeA.id,
        court,
        at(day(2), 23),
      );
      expect(fields(closed)).toEqual([
        { field: 'startsAt', code: 'BOOKING_SLOT_NOT_OFFERED' },
      ]);
      const strict = await f.facility(s.c, s.manager, {
        minMinutesBefore: 10080,
        maxDaysAhead: 9,
      });
      const soon = await f.bookRaw(s.alice, s.homeA.id, strict, at(day(2), 10));
      expect(fields(soon)).toEqual([
        {
          field: 'startsAt',
          code: 'BOOKING_TOO_SOON',
          params: { minutes: 10080 },
        },
      ]);
      const far = await f.bookRaw(s.alice, s.homeA.id, strict, at(day(10), 10));
      expect(fields(far)).toEqual([
        { field: 'startsAt', code: 'BOOKING_TOO_FAR', params: { days: 9 } },
      ]);
      expect(await f.slots(s.alice, strict, day(2))).toEqual([]);
      expect(await f.slots(s.alice, strict, day(10))).toEqual([]);
      expect((await f.slots(s.alice, strict, day(8))).length).toBeGreaterThan(
        0,
      );
    });

    it('guests: a number, at most the facility’s; counted in people, the party fits the slot', async () => {
      const none = await f.bookRaw(s.alice, s.homeA.id, court, at(day(3), 10), {
        guests: 1,
      });
      expect(fields(none)).toEqual([
        {
          field: 'guests',
          code: 'BOOKING_TOO_MANY_GUESTS',
          params: { max: 0 },
        },
      ]);
      const hall = await f.facility(s.c, s.manager, {
        capacity: 4,
        capacityUnit: 'people',
        maxGuests: 10,
      });
      const big = await f.bookRaw(s.alice, s.homeA.id, hall, at(day(3), 10), {
        guests: 4,
      });
      expect(fields(big)).toEqual([
        {
          field: 'guests',
          code: 'BOOKING_PARTY_TOO_LARGE',
          params: { max: 3 },
        },
      ]);
      await f.book(s.alice, s.homeA.id, hall, at(day(3), 10), { guests: 2 });
      // Three of four places are taken: Bob's party of two does not fit, alone he does.
      const two = await f.bookRaw(s.bob, s.homeB.id, hall, at(day(3), 10), {
        guests: 1,
      });
      expect([two.status, code(two)]).toEqual([409, 'BOOKING_SLOT_FULL']);
      const freeSlot = (await f.slots(s.bob, hall, day(3))).find(
        (x) => x.startsAt === at(day(3), 10).toISOString(),
      );
      expect(freeSlot?.state).toBe('free');
      await f.book(s.bob, s.homeB.id, hall, at(day(3), 10));
      expect(
        (await f.slots(s.bob, hall, day(3))).find(
          (x) => x.startsAt === at(day(3), 10).toISOString(),
        )?.state,
      ).toBe('full');
    });

    it('a walk-in facility takes no booking; a retired one is not found', async () => {
      const pool = (
        await f
          .http('post', '/staff/facilities', s.manager.token, {
            mode: 'walk_in',
            nameEn: 'Pool',
            nameAr: 'مسبح',
          })
          .expect(201)
      ).body as { id: string };
      const walkIn = await f.bookRaw(
        s.alice,
        s.homeA.id,
        pool.id,
        at(day(2), 10),
      );
      expect([walkIn.status, code(walkIn)]).toEqual([
        409,
        'FACILITY_NOT_BOOKABLE',
      ]);
      const retired = await f.facility(s.c, s.manager);
      await f
        .http('patch', `/staff/facilities/${retired}`, s.manager.token, {
          active: false,
        })
        .expect(200);
      const res = await f.bookRaw(s.alice, s.homeA.id, retired, at(day(2), 10));
      expect([res.status, code(res)]).toEqual([404, 'FACILITY_NOT_FOUND']);
    });

    it('a facility that requires approval: the booking waits, holding its place', async () => {
      const hall = await f.facility(s.c, s.manager, { requiresApproval: true });
      const b = await f.book(s.alice, s.homeA.id, hall, at(day(2), 12));
      expect(b.status).toBe('pending');
      const res = await f.bookRaw(s.bob, s.homeB.id, hall, at(day(2), 12));
      expect([res.status, code(res)]).toEqual([409, 'BOOKING_SLOT_FULL']);
    });
  });

  describe('who books', () => {
    it('a landlord, a member without `bookings`, someone of another unit and the staff may not', async () => {
      const unit = await f.unit(s.c, 'B');
      const tenant = await f.tenant(s.c, unit.id);
      const landlord = await f.landlord(s.c, unit.id);
      const member = await f.family(s.c, unit.id, tenant);

      const byLandlord = await f.bookRaw(
        landlord,
        unit.id,
        court,
        at(day(4), 10),
      );
      expect([byLandlord.status, code(byLandlord)]).toEqual([
        403,
        'BOOKINGS_NOT_ALLOWED',
      ]);
      // A member holds `bookings` by default: they book, until the primary takes it.
      await f.book(member, unit.id, court, at(day(4), 11));
      await f.revokeBookings(s.c, tenant, member.memberId);
      const revoked = await f.bookRaw(member, unit.id, court, at(day(4), 12));
      expect([revoked.status, code(revoked)]).toEqual([
        403,
        'BOOKINGS_NOT_ALLOWED',
      ]);
      const elsewhere = await f.bookRaw(s.bob, unit.id, court, at(day(4), 13));
      expect([elsewhere.status, code(elsewhere)]).toEqual([
        404,
        'UNIT_NOT_FOUND',
      ]);
      const staff = await f.bookRaw(s.handler, unit.id, court, at(day(4), 14));
      expect([staff.status, code(staff)]).toEqual([403, 'FORBIDDEN']);
    });
  });

  describe('who sees and cancels', () => {
    let unitId: string;
    let primary: Who;
    let member: Who;
    let other: Who;
    let byMember: BookingBody;
    let byPrimary: BookingBody;

    beforeAll(async () => {
      const unit = await f.unit(s.c, 'C');
      unitId = unit.id;
      primary = await f.owner(s.c, unitId);
      member = await f.family(s.c, unitId, primary);
      other = await f.family(s.c, unitId, primary);
      byMember = await f.book(member, unitId, court, at(day(5), 10));
      byPrimary = await f.book(primary, unitId, court, at(day(5), 11));
    }, 120_000);

    const list = async (who: Who, scope = 'upcoming') =>
      (
        (
          await f
            .http('get', `/units/${unitId}/bookings?scope=${scope}`, who.token)
            .expect(200)
        ).body as { data: BookingBody[] }
      ).data;

    it('the booker and the primary see a booking; another member sees only their own', async () => {
      expect((await list(primary)).map((b) => [b.id, b.mine])).toEqual([
        [byMember.id, false],
        [byPrimary.id, true],
      ]);
      expect((await list(member)).map((b) => b.id)).toEqual([byMember.id]);
      expect(await list(other)).toEqual([]);
      await f
        .http('get', `/bookings/${byMember.id}`, primary.token)
        .expect(200);
      const hidden = await f
        .http('get', `/bookings/${byMember.id}`, other.token)
        .expect(404);
      expect(code(hidden)).toBe('BOOKING_NOT_FOUND');
      await f.http('get', `/bookings/${byMember.id}`, s.bob.token).expect(404);
      await f.http('get', `/units/${unitId}/bookings`, s.bob.token).expect(404);
    });

    it('the booker or the primary cancels, with a reason; the slot is free again; twice is a conflict', async () => {
      const bad = await f.cancel(member, byMember.id, 'bored').expect(400);
      expect(fields(bad)).toMatchObject([
        { field: 'reasonCode', code: 'INVALID_REASON_CODE' },
      ]);
      await f.cancel(other, byMember.id).expect(404);
      await f.cancel(primary, byMember.id, 'cannot_attend').expect(204);
      expect(await f.row(s.c, byMember.id)).toMatchObject({
        status: 'cancelled',
        cancelledSide: 'resident',
        cancelReason: 'cannot_attend',
        cancelledById: primary.id,
      });
      const twice = await f.cancel(member, byMember.id).expect(409);
      expect(twice.body).toMatchObject({
        code: 'BOOKING_INVALID_TRANSITION',
        params: { status: 'cancelled' },
      });
      await f.book(s.bob, s.homeB.id, court, at(day(5), 10));
    });

    it('a confirmed booking is cancelled until the cutoff; a pending one at any time', async () => {
      const strict = await f.facility(s.c, s.manager, {
        cancelCutoffMinutes: 10080,
      });
      const confirmed = await f.book(primary, unitId, strict, at(day(2), 9));
      const late = await f.cancel(primary, confirmed.id).expect(409);
      expect(late.body).toMatchObject({
        code: 'BOOKING_CANCEL_CUTOFF_PASSED',
        params: { minutes: 10080 },
      });
      const approval = await f.facility(s.c, s.manager, {
        cancelCutoffMinutes: 10080,
        requiresApproval: true,
      });
      const pending = await f.book(primary, unitId, approval, at(day(2), 9));
      await f.cancel(primary, pending.id).expect(204);
    });

    it('past bookings are listed latest first', async () => {
      const ended = crypto.randomUUID();
      await f.inTx(s.c, (tx) =>
        tx.booking.create({
          data: {
            id: ended,
            tenantId: s.c.tenantId,
            facilityId: court,
            unitId,
            bookedById: primary.id,
            startsAt: new Date(Date.now() - 2 * 3_600_000),
            endsAt: new Date(Date.now() - 3_600_000),
            guests: 0,
            partySize: 1,
            peak: false,
            status: 'confirmed',
          },
        }),
      );
      const past = await list(primary, 'past');
      expect(past.map((b) => b.id)).toEqual([ended]);
      expect((await list(primary)).map((b) => b.id)).not.toContain(ended);
    });

    it('during a separation the primary sees only their own', async () => {
      await f.x.asManager(s.c, () =>
        f.x.residents.tagSeparation(unitId, {
          code: 'separation',
          text: 'Letter',
        }),
      );
      const seen = await list(primary);
      expect(seen.map((b) => b.id)).toContain(byPrimary.id);
      expect(seen.map((b) => b.id)).not.toContain(byMember.id);
      expect(seen.every((b) => b.mine)).toBe(true);
      await f
        .http('get', `/bookings/${byMember.id}`, primary.token)
        .expect(404);
    });
  });

  describe('peak times and the database', () => {
    it('a booking of a slot that overlaps a peak time is a peak booking', async () => {
      const lit = await f.facility(s.c, s.manager);
      await f
        .http('put', `/staff/facilities/${lit}/peak-windows`, s.manager.token, {
          windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startMinute: 1080,
            endMinute: 1200,
          })),
        })
        .expect(200);
      const peak = await f.book(s.alice, s.homeA.id, lit, at(day(6), 18));
      expect(peak.peak).toBe(true);
      const slots = await f.slots(s.alice, lit, day(6));
      expect(slots.filter((x) => x.peak).map((x) => x.startsAt)).toEqual([
        at(day(6), 18).toISOString(),
        at(day(6), 19).toISOString(),
      ]);
    });

    it('a booking keeps its slot and party, and is never deleted', async () => {
      const b = await f.book(s.alice, s.homeA.id, court, at(day(7), 10));
      await expect(
        f.inTx(
          s.c,
          (tx) =>
            tx.$executeRaw`UPDATE bookings SET guests = 3, party_size = 4 WHERE id = ${b.id}::uuid`,
        ),
      ).rejects.toThrow(/keeps its slot/);
      await expect(
        f.inTx(
          s.c,
          (tx) => tx.$executeRaw`DELETE FROM bookings WHERE id = ${b.id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|keeps its slot/);
    });
  });
});
