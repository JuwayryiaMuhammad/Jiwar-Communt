import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import {
  energyHelpers,
  type EnergySetUp,
  type MeterRead,
} from '../setup/energy';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Group {
  key: string | null;
  label: string | null;
  meters: number;
  use: string;
  cost: string | null;
  months: { month: string; use: string; cost: string | null }[];
}
interface Report {
  kind: string;
  unit: string;
  groupBy: string;
  period: { from: string; to: string; days: number };
  use: string;
  cost: string | null;
  groups: Group[];
}

/**
 * ADR 0066: consumption computed on read — each period between two live
 * readings spread over its days, the part inside the window counted at the
 * tariff in force each day, by meter, building or area; tariffs never
 * edited.
 */
describe('Energy — consumption and tariffs', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let s: EnergySetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    s = await e.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const post = (m: MeterRead, readOn: string, value: string) =>
    e
      .http('post', `/maintenance/meters/${m.id}/readings`, s.manager.token, {
        readOn,
        value,
      })
      .expect(201);
  const report = async (query: string, token = s.supervisor.token) =>
    (
      await e
        .http('get', `/maintenance/energy/consumption?${query}`, token)
        .expect(200)
    ).body as Report;
  const sum = (xs: string[]) => xs.reduce((n, x) => n + Number(x), 0);

  it('a period spread over its days; the window takes its part, by month', async () => {
    const m = await e.meter(s, { kind: 'gas' });
    await post(m, day(-20), '100');
    await post(m, day(-10), '200');
    const r = await report(
      `kind=gas&groupBy=meter&from=${day(-15)}&to=${day(-11)}`,
    );
    expect(r).toMatchObject({
      kind: 'gas',
      unit: 'm³',
      groupBy: 'meter',
      period: { from: day(-15), to: day(-11), days: 5 },
    });
    const g = r.groups.find((x) => x.key === m.id)!;
    expect(g).toMatchObject({ label: m.code, meters: 1, use: '50.0000' });
    expect(sum(g.months.map((x) => x.use))).toBeCloseTo(50, 4);
    // A reset counts from zero; the multiplier counts each step.
    const n = await e.meter(s, { kind: 'gas', multiplier: '2' });
    await post(n, day(-20), '500');
    await e
      .http('post', `/maintenance/meters/${n.id}/readings`, s.manager.token, {
        readOn: day(-10),
        value: '10',
        reset: true,
      })
      .expect(201);
    expect(
      (
        await report(`kind=gas&groupBy=meter&from=${day(-19)}&to=${day(-10)}`)
      ).groups.find((x) => x.key === n.id)!.use,
    ).toBe('20.0000');
  });

  it('priced at the tariff in force each day; never edited; one a kind and day', async () => {
    const m = await e.meter(s, { kind: 'fuel' });
    await post(m, day(-20), '0');
    await post(m, day(-10), '100');
    const tariff = (
      await e
        .http('post', '/maintenance/energy/tariffs', s.manager.token, {
          kind: 'fuel',
          effectiveOn: day(-13),
          pricePerUnit: '2.5',
        })
        .expect(201)
    ).body as { id: string; pricePerUnit: string };
    expect(tariff.pricePerUnit).toBe('2.5000');
    const g = (
      await report(`kind=fuel&groupBy=meter&from=${day(-15)}&to=${day(-11)}`)
    ).groups.find((x) => x.key === m.id)!;
    // Days -13 to -11 at 10 a day and 2.5 each; the two before, no tariff.
    expect(g).toMatchObject({ use: '50.0000', cost: '75.00' });
    expect(
      err(
        await e
          .http('post', '/maintenance/energy/tariffs', s.manager.token, {
            kind: 'fuel',
            effectiveOn: day(-13),
            pricePerUnit: '3',
          })
          .expect(409),
      ).code,
    ).toBe('DUPLICATE_RESOURCE');
    await expect(
      e.inTenant(s.c, (tx) =>
        tx.energyTariff.update({
          where: { id: tariff.id },
          data: { pricePerUnit: '1' },
        }),
      ),
    ).rejects.toThrow(/never edited/);
    const listed = (
      await e
        .http(
          'get',
          '/maintenance/energy/tariffs?kind=fuel',
          s.supervisor.token,
        )
        .expect(200)
    ).body as { id: string }[];
    expect(listed.map((t) => t.id)).toContain(tariff.id);
  });

  it('by building: a unit’s meter goes to its building; a meter’s own report by month', async () => {
    const m = await e.meter(s, { unitId: s.unit.id, kind: 'water' });
    await post(m, day(-8), '10');
    await post(m, day(-2), '22');
    const r = await report(
      `kind=water&groupBy=building&from=${day(-8)}&to=${day(-2)}`,
    );
    const g = r.groups.find((x) => x.key === s.building)!;
    expect(g).toMatchObject({ label: s.building });
    expect(Number(g.use)).toBeGreaterThanOrEqual(12);
    const mine = (
      await e
        .http(
          'get',
          `/maintenance/meters/${m.id}/consumption?from=${day(-8)}&to=${day(-2)}`,
          s.manager.token,
        )
        .expect(200)
    ).body as Report;
    expect(mine.groups).toHaveLength(1);
    expect(mine.groups[0]).toMatchObject({ key: m.id, use: '12.0000' });
  });

  it('as CSV, the same groups by month; a unit’s use is never a technician’s to read', async () => {
    const m = await e.meter(s, { kind: 'electricity' });
    await post(m, day(-4), '1');
    await post(m, day(-1), '4');
    const res = await e
      .http(
        'get',
        `/maintenance/energy/consumption/export?kind=electricity&groupBy=meter&from=${day(-4)}&to=${day(-1)}`,
        s.manager.token,
      )
      .expect(200)
      .expect('Content-Type', /text\/csv/)
      .expect('Cache-Control', /no-store/);
    const text = (res.text ?? (res.body as Buffer).toString('utf8')).replace(
      /^\uFEFF/,
      '',
    );
    expect(text.split('\r\n')[0]).toBe('group,month,use (kWh),cost (EGP)');
    expect(text).toContain(m.code);
    await e
      .http(
        'get',
        '/maintenance/energy/consumption?kind=electricity',
        s.techs[0].token,
      )
      .expect(403);
  });
});
