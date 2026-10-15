import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { vehicleHelpers, type Who } from '../setup/vehicles';

/**
 * ADR 0045: a visitor area never holds more bookings at one instant than
 * its capacity, whatever arrives at once. A booking takes the area's row
 * and counts, under it, the most bookings holding one instant of its
 * window. These races run for real and count rows afterwards.
 */
describe('Parking — visitor area capacity under concurrency', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;
  let homes: { unitId: string; who: Who }[];

  const PEOPLE = 8;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    // Each home books in several races here; its own limit has its tests.
    await v
      .http('patch', '/staff/vehicle-settings', s.manager.token, {
        maxActiveVisitorParkingBookings: 20,
      })
      .expect(200);
    homes = [];
    for (let i = 0; i < PEOPLE; i++) {
      const unit = await v.unit(s.c, 'P');
      homes.push({ unitId: unit.id, who: await v.owner(s.c, unit.id) });
    }
  }, 180_000);

  afterAll(() => h.close());

  const codes = (results: { status: number; body: unknown }[]) =>
    results
      .map((r) =>
        `${r.status} ${(r.body as { code?: string }).code ?? ''}`.trim(),
      )
      .sort();

  const held = (areaId: string) =>
    v.inTx(s.c, (tx) =>
      tx.visitorParkingBooking.count({
        where: { areaId, status: 'confirmed' },
      }),
    );

  it.each([1, 3])(
    'eight units book one window of an area of %i at once: exactly that many get it',
    async (k) => {
      const areaId = await v.area(s.c, s.manager, k);
      const startsAt = v.inMinutes(120);
      const endsAt = v.inMinutes(180);
      const results = await Promise.all(
        homes.map((x) =>
          v.parkRaw(x.who, x.unitId, { areaId, startsAt, endsAt }),
        ),
      );
      expect(codes(results)).toEqual([
        ...Array<string>(k).fill('201'),
        ...Array<string>(PEOPLE - k).fill('409 VISITOR_PARKING_FULL'),
      ]);
      expect(await held(areaId)).toBe(k);
    },
  );

  it('staggered windows: what never overlaps fits, the one spanning both does not', async () => {
    const areaId = await v.area(s.c, s.manager, 1);
    const at = (m: number) => v.inMinutes(m);
    const [a, b] = homes;
    expect(
      (
        await v.parkRaw(a.who, a.unitId, {
          areaId,
          startsAt: at(60),
          endsAt: at(120),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await v.parkRaw(b.who, b.unitId, {
          areaId,
          startsAt: at(180),
          endsAt: at(240),
        })
      ).status,
    ).toBe(201);
    // Between the two, touching both ends: free.
    expect(
      (
        await v.parkRaw(a.who, a.unitId, {
          areaId,
          startsAt: at(120),
          endsAt: at(180),
        })
      ).status,
    ).toBe(201);
    // Spanning one of them: full.
    expect(
      (
        await v.parkRaw(b.who, b.unitId, {
          areaId,
          startsAt: at(90),
          endsAt: at(150),
        })
      ).body,
    ).toMatchObject({ code: 'VISITOR_PARKING_FULL' });
  });

  it('staggered windows at once into two spaces: never three at one instant', async () => {
    const areaId = await v.area(s.c, s.manager, 2);
    const at = (m: number) => v.inMinutes(m);
    // Eight windows, each overlapping its neighbours by half.
    const results = await Promise.all(
      homes.map((x, i) =>
        v.parkRaw(x.who, x.unitId, {
          areaId,
          startsAt: at(60 + i * 30),
          endsAt: at(120 + i * 30),
        }),
      ),
    );
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    const rows = await v.inTx(s.c, (tx) =>
      tx.visitorParkingBooking.findMany({
        where: { areaId, status: 'confirmed' },
        select: { startsAt: true, endsAt: true },
      }),
    );
    for (const instant of rows.map((r) => r.startsAt.getTime()))
      expect(
        rows.filter(
          (r) =>
            r.startsAt.getTime() <= instant && r.endsAt.getTime() > instant,
        ).length,
      ).toBeLessThanOrEqual(2);
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it('a capacity cut leaves what is booked and refuses more', async () => {
    const areaId = await v.area(s.c, s.manager, 3);
    const window = {
      areaId,
      startsAt: v.inMinutes(60),
      endsAt: v.inMinutes(90),
    };
    for (const x of homes.slice(0, 3))
      expect((await v.parkRaw(x.who, x.unitId, window)).status).toBe(201);
    await v
      .http(
        'patch',
        `/staff/visitor-parking-areas/${areaId}`,
        s.manager.token,
        {
          capacity: 1,
        },
      )
      .expect(200);
    expect(await held(areaId)).toBe(3);
    expect(
      (await v.parkRaw(homes[3].who, homes[3].unitId, window)).body,
    ).toMatchObject({ code: 'VISITOR_PARKING_FULL' });
  });
});
