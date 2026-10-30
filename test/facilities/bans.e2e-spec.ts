import type { Response } from 'supertest';
import { err } from '../api/request';
import { newId } from '../../src/core/common/uuid';
import { dbDate } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

interface Ban {
  id: string;
  accountId: string;
  facilityId: string | null;
  endsOn: string | null;
  state: string;
  liftReasonCode: string | null;
  cancelledBookingIds: string[];
}

/**
 * ADR 0067: one account banned by the staff from booking one facility or
 * all, until a compound day (inclusive) or until lifted — beside a unit's
 * no-show suspension. Starting it cancels the account's bookings in its
 * scope that have not started, as the staff cancel one, and lists them;
 * book() refuses it after the capability, the unit's suspension and the
 * facility, with a code of its own.
 */
describe('Bookings: facility bans (ADR 0067)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let court: string;
  let pool: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    court = await f.facility(s.c, s.manager, { weeklyQuota: 20, capacity: 5 });
    pool = await f.facility(s.c, s.manager, {
      nameEn: 'Pool',
      weeklyQuota: 20,
      capacity: 5,
    });
  }, 180_000);

  afterAll(() => h.close());

  const ban = (body: object, as: Who = s.handler) =>
    f.http('post', '/staff/facility-bans', as.token, {
      reasonCode: 'damage',
      ...body,
    });
  const lift = (id: string, reasonCode = 'exception_granted') =>
    f.http('post', `/staff/facility-bans/${id}/lift`, s.handler.token, {
      reasonCode,
    });
  /** `res`, once its status is `status`. */
  const refusedWith = (status: number, res: Response) => {
    expect(res.status).toBe(status);
    return res;
  };
  /** A resident of a new home in the compound, its owner. */
  const someone = async () => {
    const home = await f.unit(s.c, 'A');
    return { home, who: await f.owner(s.c, home.id) };
  };

  it('from every facility: cancels what the account booked that has not started, as the staff cancel, and lists it', async () => {
    const { home, who } = await someone();
    const a = await f.book(who, home.id, court, at(day(2), 10));
    const b = await f.book(who, home.id, pool, at(day(3), 11));
    const other = await f.book(s.bob, s.homeB.id, court, at(day(2), 10));
    const past = await f.rawBooking(s.c, {
      facilityId: court,
      unitId: home.id,
      bookedById: who.id,
      startsAt: at(day(-1), 10),
    });
    const res = (await ban({ accountId: who.id }).expect(201)).body as Ban;
    expect(res).toMatchObject({
      accountId: who.id,
      facilityId: null,
      endsOn: null,
      state: 'in_force',
    });
    expect(res.cancelledBookingIds).toEqual([a.id, b.id].sort());
    for (const id of [a.id, b.id])
      expect(await f.row(s.c, id)).toMatchObject({
        status: 'cancelled',
        cancelledSide: 'staff',
        cancelReason: 'facility_ban',
        cancelledById: s.handler.id,
        banId: res.id,
      });
    expect((await f.row(s.c, other.id)).status).toBe('confirmed');
    expect((await f.row(s.c, past)).status).toBe('confirmed');
    const told = await f.notifications(
      s.c,
      who.id,
      'booking.cancelled_by_staff',
    );
    expect(told.map((n) => n.params)).toEqual([
      { reason: 'facility_ban' },
      { reason: 'facility_ban' },
    ]);
    expect(
      (await f.notifications(s.c, who.id, 'facility_ban.started')).map(
        (n) => n.params,
      ),
    ).toEqual([{ scope: 'all' }]);
    const refused = await f.bookRaw(who, home.id, pool, at(day(4), 9));
    expect(refused.status).toBe(403);
    expect(err(refused)).toMatchObject({ code: 'FACILITY_BANNED', params: {} });
    // Read again, it still lists what it cancelled.
    expect(
      (
        (
          await f
            .http('get', `/staff/facility-bans/${res.id}`, s.handler.token)
            .expect(200)
        ).body as Ban
      ).cancelledBookingIds,
    ).toEqual(res.cancelledBookingIds);
  });

  it('from one facility until a day: that facility only, through its last day; the booker sees it', async () => {
    const { home, who } = await someone();
    const here = await f.book(who, home.id, court, at(day(2), 12));
    const there = await f.book(who, home.id, pool, at(day(2), 12));
    const res = (
      await ban({
        accountId: who.id,
        facilityId: court,
        endsOn: day(3),
      }).expect(201)
    ).body as Ban;
    expect(res.cancelledBookingIds).toEqual([here.id]);
    expect((await f.row(s.c, there.id)).status).toBe('confirmed');
    expect(
      err(
        refusedWith(403, await f.bookRaw(who, home.id, court, at(day(3), 9))),
      ),
    ).toMatchObject({
      code: 'FACILITY_BANNED',
      params: { facilityId: court, until: day(3) },
    });
    await f.book(who, home.id, pool, at(day(3), 9));
    expect(
      (
        (await f.http('get', '/me/facility-bans', who.token).expect(200))
          .body as {
          data: { id: string; facilityId: string; endsOn: string }[];
        }
      ).data,
    ).toEqual([{ id: res.id, facilityId: court, endsOn: day(3) }]);
  });

  it('comes after the capability, the unit’s suspension and the facility, one code for each', async () => {
    const { home, who } = await someone();
    await ban({ accountId: who.id }).expect(201);
    expect(
      err(
        refusedWith(404, await f.bookRaw(who, home.id, newId(), at(day(2), 9))),
      ).code,
    ).toBe('FACILITY_NOT_FOUND');
    expect(
      err(await f.bookRaw(who, s.homeB.id, court, at(day(2), 9))).code,
    ).not.toBe('FACILITY_BANNED');
    const trigger = await f.rawBooking(s.c, {
      facilityId: court,
      unitId: home.id,
      bookedById: who.id,
      startsAt: at(day(-2), 10),
    });
    await f.inTx(s.c, (tx) =>
      tx.bookingSuspension.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          unitId: home.id,
          startsAt: at(day(-1), 0),
          endsAt: at(day(5), 0),
          triggerBookingId: trigger,
          noShowCount: 3,
        },
      }),
    );
    expect(
      err(refusedWith(403, await f.bookRaw(who, home.id, court, at(day(2), 9))))
        .code,
    ).toBe('BOOKINGS_SUSPENDED');
  });

  it('one in force per account and scope; lifted once, with a reason, and the account may book again', async () => {
    const { home, who } = await someone();
    const first = (
      await ban({ accountId: who.id, facilityId: pool }).expect(201)
    ).body as Ban;
    expect(
      err(await ban({ accountId: who.id, facilityId: pool }).expect(409)),
    ).toMatchObject({
      code: 'FACILITY_BAN_EXISTS',
      params: { banId: first.id },
    });
    // Another scope is another ban.
    await ban({ accountId: who.id, facilityId: court }).expect(201);
    expect(err(await lift(first.id, 'bored').expect(400)).fields).toEqual([
      {
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
        params: { allowed: ['staff_error', 'exception_granted', 'other'] },
      },
    ]);
    expect((await lift(first.id).expect(200)).body).toMatchObject({
      state: 'lifted',
      liftReasonCode: 'exception_granted',
    });
    expect(err(await lift(first.id).expect(409))).toMatchObject({
      code: 'FACILITY_BAN_OVER',
      params: { state: 'lifted' },
    });
    expect(
      (await f.notifications(s.c, who.id, 'facility_ban.lifted')).map(
        (n) => n.params,
      ),
    ).toEqual([{ scope: 'facility' }]);
    await f.book(who, home.id, pool, at(day(2), 15));
    await ban({ accountId: who.id, facilityId: pool }).expect(201);
  });

  it('one that has ended is closed by the system when the next one starts', async () => {
    const { who } = await someone();
    const old = newId();
    await f.inTx(s.c, (tx) =>
      tx.facilityBan.create({
        data: {
          id: old,
          tenantId: s.c.tenantId,
          accountId: who.id,
          reasonCode: 'damage',
          endsOn: dbDate(day(-1)),
          createdById: s.handler.id,
        },
      }),
    );
    expect(
      (
        (
          await f
            .http('get', `/staff/facility-bans/${old}`, s.handler.token)
            .expect(200)
        ).body as Ban
      ).state,
    ).toBe('ended');
    expect(err(await lift(old).expect(409)).params).toEqual({ state: 'ended' });
    await ban({ accountId: who.id }).expect(201);
    expect(
      await f.inTx(s.c, (tx) =>
        tx.facilityBan.findUniqueOrThrow({ where: { id: old } }),
      ),
    ).toMatchObject({ liftReasonCode: 'ended', liftedById: null });
  });

  it('ends from today and within a year; only an active account that books is banned', async () => {
    const { who } = await someone();
    for (const endsOn of [day(-1), day(366)])
      expect(
        err(await ban({ accountId: who.id, endsOn }).expect(400)).fields,
      ).toEqual([
        {
          field: 'endsOn',
          code: 'INVALID_VALUE',
          params: { from: day(0), to: day(365) },
        },
      ]);
    await ban({ accountId: who.id, endsOn: day(365) }).expect(201);
    for (const accountId of [s.handler.id, s.manager.id, newId()])
      expect(err(await ban({ accountId }).expect(400)).fields).toEqual([
        { field: 'accountId', code: 'BAN_ACCOUNT_NOT_ELIGIBLE' },
      ]);
    expect(
      err(await ban({ accountId: who.id, reasonCode: 'rude' }).expect(400))
        .fields?.[0],
    ).toMatchObject({ field: 'reasonCode', code: 'INVALID_REASON_CODE' });
    // Bans are the booking handlers’.
    await ban({ accountId: who.id }, s.alice).expect(403);
  });

  describe('races', () => {
    it('two bans of one account and scope at once leave one in force', async () => {
      for (let round = 0; round < 3; round++) {
        const { who } = await someone();
        const results = await Promise.all([
          ban({ accountId: who.id, facilityId: court }),
          ban({ accountId: who.id, facilityId: court }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(err(results.find((r) => r.status === 409)!).code).toBe(
          'FACILITY_BAN_EXISTS',
        );
        expect(
          await f.inTx(s.c, (tx) =>
            tx.facilityBan.count({
              where: { accountId: who.id, liftedAt: null },
            }),
          ),
        ).toBe(1);
      }
    });

    it('a ban racing a booking of the same account: the booking lands and is cancelled, or is refused', async () => {
      for (let round = 0; round < 3; round++) {
        const { home, who } = await someone();
        const [booked, banned] = await Promise.all([
          f.bookRaw(who, home.id, court, at(day(2), 8 + round)),
          ban({ accountId: who.id, facilityId: court }),
        ]);
        expect(banned.status).toBe(201);
        const cancelled = (banned.body as Ban).cancelledBookingIds;
        if (booked.status === 201)
          expect(cancelled).toEqual([(booked.body as { id: string }).id]);
        else {
          expect(booked.status).toBe(403);
          expect(err(booked).code).toBe('FACILITY_BANNED');
          expect(cancelled).toEqual([]);
        }
        expect(
          await f.inTx(s.c, (tx) =>
            tx.booking.count({
              where: {
                bookedById: who.id,
                status: { in: ['pending', 'confirmed'] },
              },
            }),
          ),
        ).toBe(0);
      }
    });
  });
});
