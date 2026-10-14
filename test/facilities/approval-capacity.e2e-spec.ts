import { BOOKING_EXPIRE_SWEEP } from '../../src/facilities/bookings/staff-bookings.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

/**
 * ADR 0044: approvals never confirm more than the capacity as it is when
 * they decide. An approval takes the facility's row FOR UPDATE: approvals
 * of a facility go one at a time, against what is confirmed then. These
 * races run for real and count rows afterwards.
 */
describe('Bookings — approvals against capacity under concurrency', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let homes: { unitId: string; who: Who }[];
  let handlers: Who[];

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    homes = [];
    for (let i = 0; i < 6; i++) {
      const unit = await f.unit(s.c, 'R');
      homes.push({ unitId: unit.id, who: await f.owner(s.c, unit.id) });
    }
    handlers = [s.handler, s.manager];
  }, 180_000);

  afterAll(() => h.close());

  const codes = (results: { status: number; body: unknown }[]) =>
    results
      .map((r) =>
        `${r.status} ${(r.body as { code?: string }).code ?? ''}`.trim(),
      )
      .sort();
  const confirmed = (facilityId: string) =>
    f.inTx(s.c, (tx) =>
      tx.booking.count({ where: { facilityId, status: 'confirmed' } }),
    );

  it.each([1, 2])(
    'six pending bookings, the capacity cut to %i, all approved at once: exactly that many are confirmed',
    async (k) => {
      const room = await f.facility(s.c, s.manager, {
        requiresApproval: true,
        capacity: 6,
      });
      const pending = [];
      for (const x of homes)
        pending.push(await f.book(x.who, x.unitId, room, at(day(2 + k), 10)));
      await f
        .http('patch', `/staff/facilities/${room}`, s.manager.token, {
          capacity: k,
        })
        .expect(200);
      const results = await Promise.all(
        pending.map((b, i) =>
          f.http(
            'post',
            `/staff/bookings/${b.id}/approve`,
            handlers[i % 2].token,
          ),
        ),
      );
      expect(codes(results)).toEqual([
        ...Array<string>(k).fill('204'),
        ...Array<string>(6 - k).fill('409 BOOKING_SLOT_FULL'),
      ]);
      expect(await confirmed(room)).toBe(k);
    },
  );

  it('people: parties approved at once never seat more than the places', async () => {
    const hall = await f.facility(s.c, s.manager, {
      requiresApproval: true,
      capacity: 12,
      capacityUnit: 'people',
      maxGuests: 3,
    });
    const pending = [];
    for (const x of homes)
      pending.push(
        await f.book(x.who, x.unitId, hall, at(day(5), 10), { guests: 1 }),
      );
    await f
      .http('patch', `/staff/facilities/${hall}`, s.manager.token, {
        capacity: 5,
      })
      .expect(200);
    const results = await Promise.all(
      pending.map((b, i) =>
        f.http(
          'post',
          `/staff/bookings/${b.id}/approve`,
          handlers[i % 2].token,
        ),
      ),
    );
    expect(codes(results)).toEqual([
      '204',
      '204',
      ...Array<string>(4).fill('409 BOOKING_SLOT_FULL'),
    ]);
    const seated = await f.inTx(s.c, (tx) =>
      tx.booking.aggregate({
        where: { facilityId: hall, status: 'confirmed' },
        _sum: { partySize: true },
      }),
    );
    expect(seated._sum.partySize).toBe(4);
  });

  it('two staff approve and reject one booking at once: one wins, the other learns its status', async () => {
    const room = await f.facility(s.c, s.manager, { requiresApproval: true });
    const [x] = homes;
    const b = await f.book(x.who, x.unitId, room, at(day(6), 10));
    const results = await Promise.all([
      f.http('post', `/staff/bookings/${b.id}/approve`, s.handler.token),
      f.http('post', `/staff/bookings/${b.id}/reject`, s.manager.token, {
        reasonCode: 'other',
      }),
    ]);
    expect(codes(results)).toEqual(['204', '409 BOOKING_INVALID_TRANSITION']);
  });

  it('the booker cancels while the staff approve: the cancellation always stands; the approval came first or learns it lost', async () => {
    const room = await f.facility(s.c, s.manager, {
      requiresApproval: true,
      cancelCutoffMinutes: 0,
    });
    const [, x] = homes;
    const b = await f.book(x.who, x.unitId, room, at(day(7), 10));
    const [approval, cancel] = await Promise.all([
      f.http('post', `/staff/bookings/${b.id}/approve`, s.handler.token),
      f.cancel(x.who, b.id),
    ]);
    expect(cancel.status).toBe(204);
    expect(['204', '409 BOOKING_INVALID_TRANSITION']).toContain(
      codes([approval])[0],
    );
    const row = await f.row(s.c, b.id);
    expect(row).toMatchObject({
      status: 'cancelled',
      cancelledSide: 'resident',
    });
    // Approved first, then cancelled: the decision is on the row.
    expect(row.decidedAt !== null).toBe(approval.status === 204);
  });

  it('the expiry sweep and an approval at once: the booking ends one way', async () => {
    const room = await f.facility(s.c, s.manager, { requiresApproval: true });
    const [, , x] = homes;
    const b = await f.book(x.who, x.unitId, room, at(day(8), 10));
    // The sweep acts as if the start had passed; the approval, by the
    // database's clock, finds it ahead.
    const [approval] = await Promise.all([
      f.http('post', `/staff/bookings/${b.id}/approve`, s.handler.token),
      f.sweep(BOOKING_EXPIRE_SWEEP, new Date(at(day(8), 10).getTime() + 1)),
    ]);
    const row = await f.row(s.c, b.id);
    if (approval.status === 204) expect(row.status).toBe('confirmed');
    else {
      expect(approval.body).toMatchObject({
        code: 'BOOKING_INVALID_TRANSITION',
      });
      expect(row).toMatchObject({
        status: 'cancelled',
        cancelReason: 'approval_expired',
      });
    }
  });
});
