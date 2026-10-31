import { dbClock } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp } from '../setup/market';

/**
 * ADR 0071: the compound's buses. The manager keeps routes and their
 * departures; residents read the timetable and the next departures on the
 * compound's clock, also in the daily brief.
 */
describe('Daily life — buses', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
  }, 180_000);

  afterAll(() => h.close());

  type Next = { routeId: string; departureId: string; at: string };
  const everyDay = [0, 1, 2, 3, 4, 5, 6];
  const route = async (nameEn: string) =>
    (
      (
        await m
          .http('post', '/community/bus-routes', s.manager.token, {
            nameEn,
            nameAr: 'خط',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  const depart = async (routeId: string, time: string, weekdays = everyDay) =>
    (
      await m
        .http(
          'post',
          `/community/bus-routes/${routeId}/departures`,
          s.manager.token,
          { weekdays, time, fromStop: 'Gate 1', toStop: 'Metro' },
        )
        .expect(201)
    ).body as { id: string; time: string; weekdays: number[] };

  it('residents read the timetable and the next departures, soonest first, never past', async () => {
    const line = await route('Line 1');
    const early = await depart(line, '00:05');
    const late = await depart(line, '23:55');
    expect(early).toMatchObject({ time: '00:05', weekdays: everyDay });
    const res = await m.http('get', '/buses', s.bob.token).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as {
      routes: { id: string; departures: { id: string }[] }[];
      next: Next[];
    };
    expect(
      body.routes.find((r) => r.id === line)?.departures.map((d) => d.id),
    ).toEqual([early.id, late.id]);
    const now = dbClock().getTime();
    const at = body.next.map((n) => Date.parse(n.at));
    expect(at.length).toBeGreaterThan(0);
    expect(at.every((t) => t > now)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(
      (
        (await m.http('get', '/me/daily-brief', s.bob.token).expect(200))
          .body as { buses: Next[] }
      ).buses.length,
    ).toBeLessThanOrEqual(3);
  });

  it('a retired route and a removed departure leave the timetable', async () => {
    const old = await route('Old line');
    const gone = await depart(old, '12:00');
    await m
      .http('patch', `/community/bus-routes/${old}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    const routes = (
      (await m.http('get', '/buses', s.bob.token).expect(200)).body as {
        routes: { id: string }[];
      }
    ).routes;
    expect(routes.map((r) => r.id)).not.toContain(old);
    await m
      .http('delete', `/community/bus-departures/${gone.id}`, s.manager.token)
      .expect(204);
    await m
      .http('delete', `/community/bus-departures/${gone.id}`, s.manager.token)
      .expect(404);
    const all = await m.list<{
      id: string;
      active: boolean;
      departures: object[];
    }>('/community/bus-routes', s.manager);
    expect(all.find((r) => r.id === old)).toMatchObject({
      active: false,
      departures: [],
    });
  });

  it('a departure needs a weekday and a real time; a resident never edits the timetable', async () => {
    const line = await route('Line 2');
    await m
      .http(
        'post',
        `/community/bus-routes/${line}/departures`,
        s.manager.token,
        {
          weekdays: [],
          time: '24:00',
          fromStop: 'A',
          toStop: 'B',
        },
      )
      .expect(400);
    await m
      .http('post', '/community/bus-routes', s.alice.token, {
        nameEn: 'Mine',
        nameAr: 'خطي',
      })
      .expect(403);
  });
});
