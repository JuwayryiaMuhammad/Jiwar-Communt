import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { VISITOR_NAMES_SWEEP } from '../../src/gate/parking/parking-sweeps';
import { vehicleHelpers, type Who } from '../setup/vehicles';
import { localDay } from '../setup/compound-clock';

const DAY = 86_400_000;

interface BookingBody {
  id: string;
  reference: string;
  areaId: string;
  areaName: string;
  visitorPassId: string | null;
  visitorName: string | null;
  status: string;
  cancelSide: string | null;
  cancelReason: string | null;
  mine: boolean;
}

/**
 * ADR 0045: a unit's own slots, the compound's visitor areas, and the
 * visitor bookings residents make there — for a pass they manage or a
 * visitor's name, within the compound's limits, cancelled by the booker,
 * the primary, the staff, or with the pass.
 */
describe('Parking', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
  }, 120_000);

  afterAll(() => h.close());

  const outcome = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });
  const fields = (res: { body: unknown }) =>
    (res.body as { fields?: unknown[] }).fields;

  async function household() {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const member = await v.family(s.c, home.id, owner);
    return { home, owner, member };
  }

  describe('slots and areas', () => {
    it('the staff give a unit its slots; its people see them and every active area’s free spaces', async () => {
      const { home, owner, member } = await household();
      const created = await v
        .http('post', '/staff/parking-slots', s.manager.token, {
          unitCode: home.code,
          code: ' b2-17 ',
          place: 'Basement 2, row C',
        })
        .expect(201);
      expect(created.body).toMatchObject({
        unitId: home.id,
        unitCode: home.code,
        code: 'B2-17',
      });
      expect(
        (
          await v.http('post', '/staff/parking-slots', s.manager.token, {
            unitCode: home.code,
            code: 'B2-17',
            place: 'Elsewhere',
          })
        ).body,
      ).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
        fields: [{ field: 'code', code: 'DUPLICATE_VALUE' }],
      });
      expect(
        fields(
          await v.http('post', '/staff/parking-slots', s.manager.token, {
            unitCode: 'NO-SUCH-UNIT',
            code: 'Z1',
            place: 'Nowhere',
          }),
        ),
      ).toEqual([{ field: 'unitCode', code: 'UNIT_CODE_UNKNOWN' }]);
      const areaId = await v.area(s.c, s.manager, 2);
      for (const who of [owner, member]) {
        const parking = (
          await v
            .http('get', `/units/${home.id}/parking`, who.token)
            .expect(200)
        ).body as {
          slots: unknown[];
          visitorAreas: { id: string; freeSpaces: number }[];
        };
        expect(parking.slots).toEqual([
          { code: 'B2-17', place: 'Basement 2, row C' },
        ]);
        expect(parking.visitorAreas).toContainEqual(
          expect.objectContaining({ id: areaId, freeSpaces: 2 }),
        );
      }
      const other = await v.unit(s.c);
      const stranger = await v.owner(s.c, other.id);
      expect(
        outcome(
          await v.http('get', `/units/${home.id}/parking`, stranger.token),
        ),
      ).toEqual({ status: 404, code: 'UNIT_NOT_FOUND' });
      const slotId = (created.body as { id: string }).id;
      await v
        .http('patch', `/staff/parking-slots/${slotId}`, s.manager.token, {
          place: 'Basement 1',
        })
        .expect(200);
      await v
        .http('delete', `/staff/parking-slots/${slotId}`, s.manager.token)
        .expect(204);
      expect(
        (
          (
            await v
              .http('get', `/units/${home.id}/parking`, owner.token)
              .expect(200)
          ).body as { slots: unknown[] }
        ).slots,
      ).toEqual([]);
    });

    it('free spaces are now’s; a retired area is hidden and takes no booking', async () => {
      const { home, owner } = await household();
      const areaId = await v.area(s.c, s.manager, 3);
      await v
        .parkRaw(owner, home.id, {
          areaId,
          startsAt: v.inMinutes(-5),
          endsAt: v.inMinutes(60),
        })
        .then((r) => expect(r.status).toBe(201));
      await v
        .parkRaw(owner, home.id, {
          areaId,
          startsAt: v.inMinutes(120),
          endsAt: v.inMinutes(180),
        })
        .then((r) => expect(r.status).toBe(201));
      const free = async () =>
        (
          (
            await v
              .http('get', `/units/${home.id}/parking`, owner.token)
              .expect(200)
          ).body as { visitorAreas: { id: string; freeSpaces: number }[] }
        ).visitorAreas.find((a) => a.id === areaId)?.freeSpaces;
      expect(await free()).toBe(2);
      await v
        .http(
          'patch',
          `/staff/visitor-parking-areas/${areaId}`,
          s.manager.token,
          {
            active: false,
          },
        )
        .expect(200);
      expect(await free()).toBeUndefined();
      expect(
        fields(
          await v.parkRaw(owner, home.id, {
            areaId,
            startsAt: v.inMinutes(300),
            endsAt: v.inMinutes(360),
          }),
        ),
      ).toEqual([{ field: 'areaId', code: 'AREA_NOT_AVAILABLE' }]);
    });
  });

  describe('booking', () => {
    let areaId: string;

    beforeAll(async () => {
      areaId = await v.area(s.c, s.manager, 50);
    });

    it('for a visitor’s name: confirmed, numbered P-, the name the booker’s', async () => {
      const { home, owner } = await household();
      const res = await v.parkRaw(owner, home.id, {
        areaId,
        visitorName: '  Mona   Ali ',
        startsAt: v.inMinutes(60),
        endsAt: v.inMinutes(120),
      });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const b = res.body as BookingBody;
      expect(b).toMatchObject({
        areaId,
        visitorPassId: null,
        visitorName: 'Mona Ali',
        status: 'confirmed',
        mine: true,
      });
      expect(b.reference).toMatch(/^P-\d{4,}$/);
    });

    it('refuses windows out of the rules, field by field', async () => {
      const { home, owner } = await household();
      const park = (startsAt: Date, endsAt: Date) =>
        v.parkRaw(owner, home.id, { areaId, startsAt, endsAt }).then(fields);
      expect(await park(v.inMinutes(-20), v.inMinutes(30))).toEqual([
        {
          field: 'startsAt',
          code: 'PARKING_TOO_EARLY',
          params: { minutes: 15 },
        },
      ]);
      expect(
        await park(v.inMinutes(15 * 24 * 60), v.inMinutes(15 * 24 * 60 + 60)),
      ).toEqual([
        { field: 'startsAt', code: 'PARKING_TOO_FAR', params: { days: 14 } },
      ]);
      expect(await park(v.inMinutes(60), v.inMinutes(70))).toEqual([
        { field: 'endsAt', code: 'PARKING_TOO_SHORT', params: { minutes: 15 } },
      ]);
      expect(await park(v.inMinutes(60), v.inMinutes(60 + 13 * 60))).toEqual([
        { field: 'endsAt', code: 'PARKING_TOO_LONG', params: { hours: 12 } },
      ]);
      expect(await park(v.inMinutes(60), v.inMinutes(30))).toEqual([
        { field: 'endsAt', code: 'ENDS_BEFORE_START' },
      ]);
      const odd = new Date(v.inMinutes(60).getTime() + 30_000);
      expect(await park(odd, v.inMinutes(120))).toEqual([
        { field: 'startsAt', code: 'INVALID_FORMAT' },
      ]);
      expect(
        fields(
          await v.parkRaw(owner, home.id, {
            areaId,
            visitorName: ' ',
            startsAt: v.inMinutes(60),
            endsAt: v.inMinutes(120),
          }),
        ),
      ).toEqual([{ field: 'visitorName', code: 'FIELD_REQUIRED' }]);
    });

    it('whoever may invite books; a landlord does not', async () => {
      const rented = await v.unit(s.c);
      const landlord = await v.landlord(s.c, rented.id);
      const tenant = await v.tenant(s.c, rented.id);
      const window = {
        areaId,
        startsAt: v.inMinutes(60),
        endsAt: v.inMinutes(90),
      };
      expect((await v.parkRaw(tenant, rented.id, window)).status).toBe(201);
      expect(outcome(await v.parkRaw(landlord, rented.id, window))).toEqual({
        status: 403,
        code: 'VISITOR_PARKING_NOT_ALLOWED',
      });
    });

    it('at most three not yet ended per unit; an ended or cancelled one frees a place', async () => {
      const { home, owner } = await household();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await v.parkRaw(owner, home.id, {
          areaId,
          startsAt: v.inMinutes(60 + i * 60),
          endsAt: v.inMinutes(90 + i * 60),
        });
        expect(r.status).toBe(201);
        ids.push((r.body as BookingBody).id);
      }
      const fourth = {
        areaId,
        startsAt: v.inMinutes(400),
        endsAt: v.inMinutes(430),
      };
      expect((await v.parkRaw(owner, home.id, fourth)).body).toMatchObject({
        code: 'VISITOR_PARKING_LIMIT_REACHED',
        params: { max: 3 },
      });
      await v
        .http(
          'delete',
          `/units/${home.id}/visitor-parking-bookings/${ids[0]}`,
          owner.token,
        )
        .expect(204);
      expect((await v.parkRaw(owner, home.id, fourth)).status).toBe(201);
    });
  });

  describe('for a visitor pass', () => {
    let areaId: string;

    beforeAll(async () => {
      areaId = await v.area(s.c, s.manager, 50);
    });

    it('a pass of the unit the caller manages, its window inside the pass’s; no name with it', async () => {
      const { home, owner, member } = await household();
      const passId = await v.pass(member, home.id);
      // The member hosts it; the primary manages it too.
      for (const who of [member, owner]) {
        const res = await v.parkRaw(who, home.id, {
          areaId,
          visitorPassId: passId,
          startsAt: v.inMinutes(30),
          endsAt: v.inMinutes(60),
        });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          visitorPassId: passId,
          visitorName: null,
        });
      }
      expect(
        fields(
          await v.parkRaw(owner, home.id, {
            areaId,
            visitorPassId: passId,
            visitorName: 'Also a name',
            startsAt: v.inMinutes(30),
            endsAt: v.inMinutes(60),
          }),
        ),
      ).toEqual([{ field: 'visitorName', code: 'FIELD_NOT_ALLOWED' }]);
      const res = await v.parkRaw(owner, home.id, {
        areaId,
        visitorPassId: passId,
        startsAt: v.inMinutes(5 * 60),
        endsAt: v.inMinutes(7 * 60),
      });
      expect(fields(res)).toEqual([
        {
          field: 'startsAt',
          code: 'PARKING_OUTSIDE_PASS',
          params: {
            validFrom: expect.any(String) as string,
            validUntil: expect.any(String) as string,
          },
        },
      ]);
    });

    it('another unit’s pass, or one a member did not make, is not available — one answer', async () => {
      const a = await household();
      const b = await household();
      const second = await v.family(s.c, a.home.id, a.owner);
      const primarysPass = await v.pass(a.owner, a.home.id);
      const theirs = await v.pass(b.owner, b.home.id);
      const window = { startsAt: v.inMinutes(30), endsAt: v.inMinutes(60) };
      for (const [who, passId] of [
        [a.owner, theirs],
        [second, primarysPass],
        [a.owner, '01a13e8e-0000-7000-8000-000000000000'],
      ] as [Who, string][])
        expect(
          fields(
            await v.parkRaw(who, a.home.id, {
              areaId,
              visitorPassId: passId,
              ...window,
            }),
          ),
        ).toEqual([{ field: 'visitorPassId', code: 'PASS_NOT_AVAILABLE' }]);
    });

    it('cancelling the pass cancels its bookings not yet ended, by the system', async () => {
      const { home, owner } = await household();
      const passId = await v.pass(owner, home.id);
      const booking = (
        await v.parkRaw(owner, home.id, {
          areaId,
          visitorPassId: passId,
          startsAt: v.inMinutes(30),
          endsAt: v.inMinutes(90),
        })
      ).body as BookingBody;
      await v
        .http('post', `/visitor-passes/${passId}/cancel`, owner.token, {
          reasonCode: 'plans_changed',
        })
        .expect(204);
      const row = await v.inTx(s.c, (tx) =>
        tx.visitorParkingBooking.findUniqueOrThrow({
          where: { id: booking.id },
        }),
      );
      expect(row).toMatchObject({
        status: 'cancelled',
        cancelSide: 'system',
        cancelReason: 'pass_cancelled',
        cancelledById: null,
      });
      // A cancelled pass takes no booking.
      expect(
        fields(
          await v.parkRaw(owner, home.id, {
            areaId,
            visitorPassId: passId,
            startsAt: v.inMinutes(30),
            endsAt: v.inMinutes(60),
          }),
        ),
      ).toEqual([{ field: 'visitorPassId', code: 'PASS_NOT_AVAILABLE' }]);
    });
  });

  describe('who sees and cancels', () => {
    let areaId: string;

    beforeAll(async () => {
      areaId = await v.area(s.c, s.manager, 50);
    });

    it('the primary sees every booking without the visitor’s name; a member their own', async () => {
      const { home, owner, member } = await household();
      const mine = (
        await v.parkRaw(member, home.id, {
          areaId,
          visitorName: 'Member guest',
          startsAt: v.inMinutes(60),
          endsAt: v.inMinutes(90),
        })
      ).body as BookingBody;
      await v.parkRaw(owner, home.id, {
        areaId,
        visitorName: 'Owner guest',
        startsAt: v.inMinutes(60),
        endsAt: v.inMinutes(90),
      });
      const list = async (who: Who) =>
        (
          (
            await v
              .http(
                'get',
                `/units/${home.id}/visitor-parking-bookings`,
                who.token,
              )
              .expect(200)
          ).body as { data: BookingBody[] }
        ).data;
      const seenByOwner = await list(owner);
      expect(seenByOwner).toHaveLength(2);
      expect(seenByOwner.find((b) => b.id === mine.id)).toMatchObject({
        visitorName: null,
        mine: false,
      });
      expect((await list(member)).map((b) => b.id)).toEqual([mine.id]);
    });

    it('its booker or the primary cancels, once, until it ends; another member does not see it', async () => {
      const { home, owner, member } = await household();
      const second = await v.family(s.c, home.id, owner);
      const make = async (who: Who) =>
        (
          (
            await v.parkRaw(who, home.id, {
              areaId,
              startsAt: v.inMinutes(60),
              endsAt: v.inMinutes(90),
            })
          ).body as BookingBody
        ).id;
      const one = await make(member);
      const path = (id: string) =>
        `/units/${home.id}/visitor-parking-bookings/${id}`;
      expect(outcome(await v.http('delete', path(one), second.token))).toEqual({
        status: 404,
        code: 'VISITOR_PARKING_BOOKING_NOT_FOUND',
      });
      await v.http('delete', path(one), owner.token).expect(204);
      expect(outcome(await v.http('delete', path(one), member.token))).toEqual({
        status: 409,
        code: 'VISITOR_PARKING_INVALID_TRANSITION',
      });
      const two = await make(member);
      await v.http('delete', path(two), member.token).expect(204);
      expect(
        await v.inTx(s.c, (tx) =>
          tx.visitorParkingBooking.findUniqueOrThrow({ where: { id: two } }),
        ),
      ).toMatchObject({
        cancelSide: 'resident',
        cancelReason: 'no_longer_needed',
        cancelledById: member.id,
      });
    });

    it('the staff see the day with the visitor and the booker, and cancel with a reason', async () => {
      const { home, owner } = await household();
      const startsAt = v.inMinutes(30);
      const booking = (
        await v.parkRaw(owner, home.id, {
          areaId,
          visitorName: 'Staff-seen guest',
          startsAt,
          endsAt: v.inMinutes(60),
        })
      ).body as BookingBody;
      // The booking's own local day: half an hour from now may be tomorrow.
      const on = localDay(startsAt);
      const day = (
        await v
          .http(
            'get',
            `/staff/visitor-parking-bookings?areaId=${areaId}&day=${on}`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: Record<string, unknown>[] };
      expect(day.data.find((b) => b.id === booking.id)).toMatchObject({
        unitCode: home.code,
        visitorName: 'Staff-seen guest',
        bookedBy: { id: owner.id },
      });
      await v
        .http(
          'post',
          `/staff/visitor-parking-bookings/${booking.id}/cancel`,
          s.manager.token,
          { reasonCode: 'misuse' },
        )
        .expect(204);
      expect(
        await v.inTx(s.c, (tx) =>
          tx.visitorParkingBooking.findUniqueOrThrow({
            where: { id: booking.id },
          }),
        ),
      ).toMatchObject({
        cancelSide: 'staff',
        cancelReason: 'misuse',
        cancelledById: s.manager.id,
      });
    });

    it('the visitor’s name goes 30 days after the booking ends; the booking stays', async () => {
      const { home, owner } = await household();
      const booking = (
        await v.parkRaw(owner, home.id, {
          areaId,
          visitorName: 'Forgotten guest',
          startsAt: v.inMinutes(30),
          endsAt: v.inMinutes(60),
        })
      ).body as BookingBody;
      const row = () =>
        v.inTx(s.c, (tx) =>
          tx.visitorParkingBooking.findUniqueOrThrow({
            where: { id: booking.id },
          }),
        );
      await v.sweep(VISITOR_NAMES_SWEEP, new Date(Date.now() + 29 * DAY));
      expect((await row()).visitorName).toBe('Forgotten guest');
      await v.sweep(VISITOR_NAMES_SWEEP, new Date(Date.now() + 31 * DAY));
      expect(await row()).toMatchObject({
        visitorName: null,
        visitorNameClearedAt: expect.any(Date) as Date,
        status: 'confirmed',
      });
    });
  });
});
