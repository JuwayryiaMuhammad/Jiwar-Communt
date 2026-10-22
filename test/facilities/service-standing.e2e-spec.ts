import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { superuserSql } from '../setup/governance';
import { dbClock } from '../setup/compound-clock';
import { facilitiesHelpers } from '../setup/facilities';
import { bookingRow, suspensionRow } from '../setup/facilities-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof facilitiesHelpers>['setUp']>>;

interface Standing {
  service: string;
  reason: string;
  since: string;
  until: string | null;
  restore: string[];
  appealUntil: string | null;
}

/**
 * The services a unit is suspended from (ADR 0058): why, until when, and
 * how each is restored — for whoever has a place on the unit.
 */
describe('Facilities — the unit’s service standing', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
  });

  afterAll(() => h.close());

  const standing = async (unitId: string, token = s.alice.token) =>
    (
      (
        await f
          .http('get', `/me/units/${unitId}/service-standing`, token)
          .expect(200)
      ).body as { data: Standing[] }
    ).data;

  it('none, then a booking suspension with its reason, its end and the board', async () => {
    expect(await standing(s.homeA.id)).toEqual([]);
    const facilityId = await f.facility(s.c, s.manager);
    const id = await f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx(async (tx) =>
        suspensionRow(tx, {
          tenantId: s.c.tenantId,
          unitId: s.homeA.id,
          triggerBookingId: await bookingRow(tx, {
            tenantId: s.c.tenantId,
            facilityId,
            unitId: s.homeA.id,
            bookedById: s.alice.id,
          }),
        }),
      ),
    );
    const [one] = await standing(s.homeA.id);
    expect(one).toMatchObject({
      service: 'bookings',
      reason: 'no_shows',
      restore: ['wait_until', 'appeal_board'],
    });
    expect(new Date(one.appealUntil!).getTime()).toBe(
      new Date(one.since).getTime() + 15 * 86_400_000,
    );
    // Appealed: waiting is what is left.
    await superuserSql(
      `UPDATE booking_suspensions SET board_appeal_at = $2 WHERE id = $1`,
      [id, dbClock()],
    );
    expect((await standing(s.homeA.id))[0]).toMatchObject({
      restore: ['wait_until'],
      appealUntil: null,
    });
    // Another unit's is not this one's.
    expect(await standing(s.homeB.id, s.bob.token)).toEqual([]);
  });

  it('a unit the caller has no place in is not found', async () => {
    const res = await f
      .http('get', `/me/units/${s.homeA.id}/service-standing`, s.bob.token)
      .expect(404);
    expect((res.body as { code: string }).code).toBe('UNIT_NOT_FOUND');
  });
});
