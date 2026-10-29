import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import {
  energyHelpers,
  type EnergySetUp,
  type MeterRead,
} from '../setup/energy';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Card {
  id: string;
  title: string;
  kind: string;
  meterId: string | null;
  building: string | null;
  startsOn: string;
  endedOn: string | null;
  cost: string | null;
  effect: {
    weeks: number;
    before: { from: string; to: string; perDay: string };
    after: { from: string; to: string; perDay: string } | null;
    complete: boolean;
    changePct: string | null;
  };
}

/**
 * ADR 0066: a saving measure on a meter, a building or the compound; its
 * effect read now as the use a day over whole weeks before its start
 * against the same weeks from it; ended once.
 */
describe('Energy — saving measures', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let s: EnergySetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    s = await e.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const create = (body: object) =>
    e.http('post', '/maintenance/energy/measures', s.manager.token, {
      title: 'LED lights',
      kind: 'electricity',
      startsOn: day(-27),
      ...body,
    });
  const card = async (id: string, weeks?: number) =>
    (
      await e
        .http(
          'get',
          `/maintenance/energy/measures/${id}${weeks ? `?weeks=${weeks}` : ''}`,
          s.supervisor.token,
        )
        .expect(200)
    ).body as Card;

  /** 10 a day up to day -28, then 5 a day, read weekly. */
  async function halved(): Promise<MeterRead> {
    const m = await e.meter(s, { kind: 'electricity' });
    const values: [number, number][] = [
      [-63, 0],
      [-56, 70],
      [-49, 140],
      [-42, 210],
      [-35, 280],
      [-28, 350],
      [-21, 385],
      [-14, 420],
      [-7, 455],
      [0, 490],
    ];
    for (const [d, v] of values)
      await e
        .http('post', `/maintenance/meters/${m.id}/readings`, s.manager.token, {
          readOn: day(d),
          value: String(v),
        })
        .expect(201);
    return m;
  }

  it('its effect: whole weeks before against the same weeks from its start, read now', async () => {
    const m = await halved();
    const made = (await create({ meterId: m.id, cost: '1200' }).expect(201))
      .body as Card;
    expect(made).toMatchObject({
      meterId: m.id,
      cost: '1200.00',
      endedOn: null,
    });
    expect((await card(made.id)).effect).toEqual({
      weeks: 4,
      before: { from: day(-55), to: day(-28), perDay: '10.0000' },
      after: { from: day(-27), to: day(0), perDay: '5.0000' },
      complete: true,
      changePct: '-50.0',
    });
    const longer = (await card(made.id, 8)).effect;
    expect(longer.complete).toBe(false);
    expect(longer.after).toMatchObject({ from: day(-27), to: day(0) });
  });

  it('on one meter of its kind, one building that exists, or the compound; at most a year ahead', async () => {
    const water = await e.meter(s, { kind: 'water' });
    expect(err(await create({ meterId: water.id }).expect(400)).fields).toEqual(
      [{ field: 'meterId', code: 'METER_NOT_AVAILABLE' }],
    );
    expect(
      err(await create({ meterId: water.id, building: s.building }).expect(400))
        .fields,
    ).toEqual([{ field: 'building', code: 'FIELD_NOT_ALLOWED' }]);
    expect(
      err(await create({ building: 'No such tower' }).expect(400)).fields,
    ).toEqual([{ field: 'building', code: 'BUILDING_NOT_FOUND' }]);
    expect(
      err(await create({ startsOn: day(400) }).expect(400)).fields,
    ).toEqual([
      {
        field: 'startsOn',
        code: 'INVALID_VALUE',
        params: { maxDaysAhead: 366 },
      },
    ]);
    expect(
      ((await create({ building: s.building }).expect(201)).body as Card)
        .building,
    ).toBe(s.building);
    expect(((await create({}).expect(201)).body as Card).meterId).toBeNull();
  });

  it('ended once, from its start to today; never changed', async () => {
    const made = (await create({ startsOn: day(-10) }).expect(201))
      .body as Card;
    const end = (endedOn: string) =>
      e.http(
        'post',
        `/maintenance/energy/measures/${made.id}/end`,
        s.manager.token,
        { endedOn },
      );
    for (const d of [day(-11), day(1)])
      expect(err(await end(d).expect(400)).fields).toEqual([
        { field: 'endedOn', code: 'INVALID_VALUE' },
      ]);
    expect(((await end(day(-2)).expect(200)).body as Card).endedOn).toBe(
      day(-2),
    );
    expect(err(await end(day(-1)).expect(409)).code).toBe(
      'ENERGY_MEASURE_ENDED',
    );
    // An ended measure is read up to its end.
    expect((await card(made.id)).effect.after?.to).toBe(day(-2));
    await expect(
      e.inTenant(s.c, (tx) =>
        tx.energyMeasure.update({
          where: { id: made.id },
          data: { title: 'Other' },
        }),
      ),
    ).rejects.toThrow(/keeps what it was/);
    await e
      .http('get', `/maintenance/energy/measures/${made.id}`, s.techs[0].token)
      .expect(403);
  });
});
