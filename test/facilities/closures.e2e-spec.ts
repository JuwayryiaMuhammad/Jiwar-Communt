import { Client } from 'pg';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
} from '../setup/facilities';
import { required } from '../setup/test-env';

const fields = (res: { body: unknown }) =>
  (res.body as { fields: unknown[] }).fields;

describe('Facilities: closures (ADR 0044)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
  }, 180_000);

  afterAll(() => h.close());

  const close = (
    facilityId: string,
    startsAt: Date,
    endsAt: Date,
    reasonCode = 'maintenance',
  ) =>
    f.http(
      'post',
      `/staff/facilities/${facilityId}/closures`,
      s.manager.token,
      {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reasonCode,
      },
    );

  it('a closure cancels the future bookings it overlaps, by the system, and tells each booker; others stay', async () => {
    const court = await f.facility(s.c, s.manager, { capacity: 2 });
    const inside = await f.book(s.alice, s.homeA.id, court, at(day(2), 10));
    const touching = await f.book(s.bob, s.homeB.id, court, at(day(2), 12));
    const res = await close(court, at(day(2), 9, 30), at(day(2), 12)).expect(
      201,
    );
    expect(res.body).toMatchObject({
      facilityId: court,
      reasonCode: 'maintenance',
      liftedAt: null,
      cancelledBookings: 1,
    });
    const closureId = (res.body as { id: string }).id;
    expect(await f.row(s.c, inside.id)).toMatchObject({
      status: 'cancelled',
      cancelledSide: 'system',
      cancelReason: 'facility_closed',
      cancelledById: null,
      closureId,
    });
    expect((await f.row(s.c, touching.id)).status).toBe('confirmed');
    expect(
      (
        await f.notifications(s.c, s.alice.id, 'booking.cancelled_by_closure')
      ).map((n) => n.params),
    ).toEqual([{ reason: 'maintenance' }]);
    expect(
      await f.notifications(s.c, s.bob.id, 'booking.cancelled_by_closure'),
    ).toEqual([]);
  });

  it('a closed slot is shown closed and refuses a booking; residents see the closure, lifted ones not', async () => {
    const court = await f.facility(s.c, s.manager);
    const res = await close(
      court,
      at(day(3), 10),
      at(day(3), 11),
      'cleaning',
    ).expect(201);
    const slot = (await f.slots(s.alice, court, day(3))).find(
      (x) => x.startsAt === at(day(3), 10).toISOString(),
    );
    expect(slot?.state).toBe('closed');
    const refused = await f.bookRaw(s.alice, s.homeA.id, court, at(day(3), 10));
    expect([refused.status, (refused.body as { code: string }).code]).toEqual([
      409,
      'FACILITY_CLOSED',
    ]);
    const seen = (
      await f.http('get', `/facilities/${court}`, s.alice.token).expect(200)
    ).body as { closures: unknown[] };
    expect(seen.closures).toEqual([
      {
        startsAt: at(day(3), 10).toISOString(),
        endsAt: at(day(3), 11).toISOString(),
        reasonCode: 'cleaning',
      },
    ]);

    const id = (res.body as { id: string }).id;
    await f
      .http('post', `/staff/facility-closures/${id}/lift`, s.manager.token, {
        reasonCode: 'reopened_early',
      })
      .expect(204);
    const again = await f
      .http('post', `/staff/facility-closures/${id}/lift`, s.manager.token, {
        reasonCode: 'other',
      })
      .expect(409);
    expect(again.body).toMatchObject({ code: 'FACILITY_CLOSURE_LIFTED' });
    expect(
      (
        (await f.http('get', `/facilities/${court}`, s.alice.token).expect(200))
          .body as { closures: unknown[] }
      ).closures,
    ).toEqual([]);
    await f.book(s.alice, s.homeA.id, court, at(day(3), 10));
  });

  it('a booking under way is left as it is; what a closure cancelled stays cancelled after it is lifted', async () => {
    const court = await f.facility(s.c, s.manager);
    const under = await f.rawBooking(s.c, {
      facilityId: court,
      unitId: s.homeB.id,
      bookedById: s.bob.id,
      startsAt: new Date(Date.now() - 10 * 60_000),
    });
    const ahead = await f.book(s.bob, s.homeB.id, court, at(day(4), 10));
    const res = await close(
      court,
      new Date(Date.now() - 60_000),
      at(day(5), 0),
    ).expect(201);
    expect((res.body as { cancelledBookings: number }).cancelledBookings).toBe(
      1,
    );
    expect((await f.row(s.c, under)).status).toBe('confirmed');
    await f
      .http(
        'post',
        `/staff/facility-closures/${(res.body as { id: string }).id}/lift`,
        s.manager.token,
        {
          reasonCode: 'created_in_error',
        },
      )
      .expect(204);
    expect((await f.row(s.c, ahead.id)).status).toBe('cancelled');
  });

  it('a window ends after it starts, lasts at most 366 days, and is not over', async () => {
    const court = await f.facility(s.c, s.manager);
    expect(
      fields(await close(court, at(day(3), 10), at(day(3), 10)).expect(400)),
    ).toEqual([{ field: 'endsAt', code: 'ENDS_BEFORE_START' }]);
    expect(
      fields(await close(court, at(day(3), 10), at(day(370), 10)).expect(400)),
    ).toEqual([
      { field: 'endsAt', code: 'CLOSURE_TOO_LONG', params: { days: 366 } },
    ]);
    expect(
      fields(
        await close(
          court,
          new Date(Date.now() - 7_200_000),
          new Date(Date.now() - 3_600_000),
        ).expect(400),
      ),
    ).toEqual([{ field: 'endsAt', code: 'CLOSURE_ENDED' }]);
    expect(
      fields(
        await close(court, at(day(3), 10), at(day(3), 11), 'holiday').expect(
          400,
        ),
      ),
    ).toMatchObject([{ field: 'reasonCode', code: 'INVALID_REASON_CODE' }]);
  });

  it('the staff list a facility’s closures; a handler may read them, not create them', async () => {
    const court = await f.facility(s.c, s.manager);
    await close(court, at(day(5), 10), at(day(5), 11)).expect(201);
    await close(court, at(day(6), 10), at(day(6), 11)).expect(201);
    const list = (
      await f
        .http('get', `/staff/facilities/${court}/closures`, s.handler.token)
        .expect(200)
    ).body as { data: { startsAt: string }[] };
    expect(list.data.map((c) => c.startsAt)).toEqual([
      at(day(6), 10).toISOString(),
      at(day(5), 10).toISOString(),
    ]);
    await f
      .http('post', `/staff/facilities/${court}/closures`, s.handler.token, {
        startsAt: at(day(7), 10).toISOString(),
        endsAt: at(day(7), 11).toISOString(),
        reasonCode: 'other',
      })
      .expect(403);
  });

  it('a closure keeps its window and is lifted once (the database)', async () => {
    const court = await f.facility(s.c, s.manager);
    const id = (
      (await close(court, at(day(7), 10), at(day(7), 11)).expect(201)).body as {
        id: string;
      }
    ).id;
    await expect(
      f.inTx(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE facility_closures SET ends_at = ends_at + interval '1 hour' WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow(/keeps its window/);
  });

  describe('a booking racing a closure', () => {
    it('a booking waiting on the facility while a closure is decided is refused once it commits', async () => {
      const court = await f.facility(s.c, s.manager);
      // Another connection holds the facility's row as a closure would.
      const held = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await held.connect();
      await held.query('BEGIN');
      await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      await held.query(`SELECT id FROM facilities WHERE id = $1 FOR UPDATE`, [
        court,
      ]);
      const booking = f.bookRaw(s.alice, s.homeA.id, court, at(day(8), 10));
      for (let i = 0; i < 100; i++) {
        const waiting = await held.query(
          `SELECT count(*) AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE NOT l.granted AND c.relname = 'facilities'`,
        );
        if (Number((waiting.rows[0] as { n: string }).n) > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await held.query(
        `INSERT INTO facility_closures (id, tenant_id, facility_id, starts_at, ends_at, reason_code, created_by_account_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'weather', $5)`,
        [s.c.tenantId, court, at(day(8), 0), at(day(9), 0), s.manager.id],
      );
      await held.query('COMMIT');
      await held.end();
      const res = await booking;
      expect([res.status, (res.body as { code: string }).code]).toEqual([
        409,
        'FACILITY_CLOSED',
      ]);
      expect(await f.holding(s.c, court)).toBe(0);
    });
  });
});
