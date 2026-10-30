import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
} from '../setup/facilities';

interface UsageRow {
  facilityId: string;
  nameEn: string;
  bookings: Record<string, number>;
  openMinutes: number;
  bookedMinutes: number;
  use: number | null;
  noShows: number;
  noShowRate: number | null;
  peakShare: number | null;
}

/**
 * ADR 0067: how each bookable facility is used over a period, computed on
 * read — bookings by status, booked time over the time its hours offered
 * (minus closures in force) times its capacity, no-shows and the share at
 * peak times — for who sets up the facilities or works the bookings, and
 * as CSV.
 */
describe('Bookings: facility usage (ADR 0067)', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let court: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    court = await f.facility(s.c, s.manager, { weeklyQuota: 20, capacity: 2 });
  }, 180_000);

  afterAll(() => h.close());

  const report = (q: string, token = s.handler.token) =>
    f.http('get', `/staff/facility-usage?${q}`, token);

  it('counts a day’s bookings by status; use is booked time over open time, minus a closure, times capacity', async () => {
    const on = day(2);
    await f.book(s.alice, s.homeA.id, court, at(on, 10));
    await f.book(s.bob, s.homeB.id, court, at(on, 10));
    const off = await f.book(s.alice, s.homeA.id, court, at(on, 11));
    await f.cancel(s.alice, off.id).expect(204);
    await f
      .http('post', `/staff/facilities/${court}/closures`, s.manager.token, {
        startsAt: at(on, 20).toISOString(),
        endsAt: at(on, 22).toISOString(),
        reasonCode: 'maintenance',
      })
      .expect(201);
    const body = (await report(`from=${on}&to=${on}`).expect(200)).body as {
      from: string;
      to: string;
      days: number;
      facilities: UsageRow[];
    };
    expect(body).toMatchObject({ from: on, to: on, days: 1 });
    expect(body.facilities.find((r) => r.facilityId === court)).toEqual({
      facilityId: court,
      nameEn: 'Court',
      nameAr: 'ملعب',
      bookings: {
        pending: 0,
        confirmed: 2,
        rejected: 0,
        cancelled: 1,
        no_show: 0,
      },
      // 06:00–22:00, the last two hours closed: 14 hours open.
      openMinutes: 840,
      bookedMinutes: 120,
      // 120 over 840 × 2.
      use: 7,
      noShows: 0,
      noShowRate: 0,
      peakShare: 0,
    });
  });

  it('a period is 30 days ending today by default, its end on or after its start, a year and a day at most', async () => {
    expect((await report('').expect(200)).body).toMatchObject({
      from: day(-29),
      to: day(0),
      days: 30,
    });
    expect(
      err(await report(`from=${day(2)}&to=${day(1)}`).expect(400)).fields,
    ).toEqual([{ field: 'to', code: 'ENDS_BEFORE_START' }]);
    expect(
      err(await report(`from=${day(-366)}&to=${day(0)}`).expect(400)).fields,
    ).toEqual([
      { field: 'from', code: 'PERIOD_TOO_LONG', params: { max: 366 } },
    ]);
  });

  it('is for who sets up the facilities or works the bookings, never a resident; the CSV names no one', async () => {
    await report('', s.manager.token).expect(200);
    await report('', s.alice.token).expect(403);
    const csv = await f
      .http(
        'get',
        `/staff/facility-usage/export?from=${day(2)}&to=${day(2)}`,
        s.handler.token,
      )
      .expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['cache-control']).toBe('no-store');
    const text = csv.text.replace(/^\uFEFF/, '');
    const [header, ...rows] = text.trim().split('\r\n');
    expect(header).toBe(
      'facility,pending,confirmed,rejected,cancelled,no_show,open_minutes,booked_minutes,use_percent,no_show_percent,peak_percent',
    );
    expect(rows).toContain('Court,0,2,0,1,0,840,120,7,0,0');
    expect(text).not.toContain('Alice');
  });
});
