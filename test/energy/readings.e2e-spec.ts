import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import {
  energyHelpers,
  type EnergySetUp,
  type MeterRead,
} from '../setup/energy';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Reading {
  id: string;
  meterId: string;
  readOn: string;
  value: string;
  reset: boolean;
  source: string;
  supersedesId: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
}

/**
 * ADR 0066: a meter's readings — a day of the compound's calendar each,
 * one live a day, a cumulative register checked against the live
 * readings on both sides, a correction or a withdrawal once, every write
 * decided under the meter's FOR UPDATE.
 */
describe('Energy — readings', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let s: EnergySetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    s = await e.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const post = (m: MeterRead, readOn: string, value: string, more = {}) =>
    e.http('post', `/maintenance/meters/${m.id}/readings`, s.manager.token, {
      readOn,
      value,
      ...more,
    });
  const add = async (m: MeterRead, readOn: string, value: string, more = {}) =>
    (await post(m, readOn, value, more).expect(201)).body as Reading;
  const correct = (m: MeterRead, r: Reading, body: object) =>
    e.http(
      'post',
      `/maintenance/meters/${m.id}/readings/${r.id}/correct`,
      s.manager.token,
      body,
    );
  const live = async (m: MeterRead, superseded = false) =>
    (
      (
        await e
          .http(
            'get',
            `/maintenance/meters/${m.id}/readings${superseded ? '?superseded=true' : ''}`,
            s.supervisor.token,
          )
          .expect(200)
      ).body as { data: Reading[] }
    ).data;

  it('one live reading a day, by today and at most 400 days back', async () => {
    const m = await e.meter(s);
    const first = await add(m, day(-2), '100.5');
    expect(first).toMatchObject({
      readOn: day(-2),
      value: '100.5000',
      reset: false,
      source: 'manual',
      supersedesId: null,
    });
    expect(err(await post(m, day(-2), '101').expect(409))).toMatchObject({
      code: 'READING_EXISTS',
      params: { readingId: first.id },
    });
    for (const d of [day(1), day(-401)])
      expect(err(await post(m, d, '102').expect(400)).fields).toEqual([
        {
          field: 'readOn',
          code: 'INVALID_VALUE',
          params: { maxDaysBack: 400 },
        },
      ]);
    expect(err(await post(m, '2026-02-30', '102').expect(400)).fields).toEqual([
      { field: 'readOn', code: 'INVALID_FORMAT' },
    ]);
  });

  it('a cumulative register is checked against the live readings on both sides; a reset ends the check on its side', async () => {
    const m = await e.meter(s);
    await add(m, day(-20), '100');
    await add(m, day(-10), '150');
    expect(err(await post(m, day(-15), '90').expect(400)).fields).toEqual([
      {
        field: 'value',
        code: 'READING_BELOW_PREVIOUS',
        params: { previous: '100.0000' },
      },
    ]);
    expect(err(await post(m, day(-15), '160').expect(400)).fields).toEqual([
      {
        field: 'value',
        code: 'READING_ABOVE_NEXT',
        params: { next: '150.0000' },
      },
    ]);
    await add(m, day(-15), '120');
    // A reset: the register starts again, below the reading before it.
    await add(m, day(-5), '3', { reset: true });
    // Before a reset, nothing above caps it.
    await add(m, day(-7), '900');
    expect(err(await post(m, day(-6), '800').expect(400)).fields).toEqual([
      {
        field: 'value',
        code: 'READING_BELOW_PREVIOUS',
        params: { previous: '900.0000' },
      },
    ]);
    expect(err(await post(m, day(-3), '2').expect(400)).fields).toEqual([
      {
        field: 'value',
        code: 'READING_BELOW_PREVIOUS',
        params: { previous: '3.0000' },
      },
    ]);
  });

  it('an interval meter keeps no order', async () => {
    const m = await e.meter(s, { mode: 'interval' });
    await add(m, day(-10), '50');
    await add(m, day(-5), '5');
    await add(m, day(-7), '500');
  });

  it('corrected once, with a reason, against its neighbours without the row it corrects; or withdrawn', async () => {
    const m = await e.meter(s);
    await add(m, day(-20), '100');
    const mid = await add(m, day(-10), '150');
    await add(m, day(-5), '200');
    expect(err(await correct(m, mid, { value: '140' }).expect(400)).code).toBe(
      'REASON_REQUIRED',
    );
    expect(
      err(
        await correct(m, mid, { value: '210', reasonCode: 'misread' }).expect(
          400,
        ),
      ).fields,
    ).toEqual([
      {
        field: 'value',
        code: 'READING_ABOVE_NEXT',
        params: { next: '200.0000' },
      },
    ]);
    const fixed = (
      await correct(m, mid, { value: '140', reasonCode: 'misread' }).expect(201)
    ).body as Reading;
    expect(fixed).toMatchObject({
      readOn: day(-10),
      value: '140.0000',
      supersedesId: mid.id,
    });
    expect(
      err(
        await correct(m, mid, { value: '141', reasonCode: 'misread' }).expect(
          409,
        ),
      ).code,
    ).toBe('READING_ALREADY_CORRECTED');
    // Moved to a day another reading holds: correct that one instead.
    expect(
      err(
        await correct(m, fixed, {
          value: '190',
          readOn: day(-5),
          reasonCode: 'wrong_day',
        }).expect(409),
      ).code,
    ).toBe('READING_EXISTS');
    const gone = (
      await e
        .http(
          'post',
          `/maintenance/meters/${m.id}/readings/${fixed.id}/withdraw`,
          s.manager.token,
          { reasonCode: 'wrong_meter' },
        )
        .expect(200)
    ).body as Reading;
    expect(gone).toMatchObject({ supersededReason: 'wrong_meter' });
    expect((await live(m)).map((r) => r.readOn)).toEqual([day(-5), day(-20)]);
    expect(await live(m, true)).toHaveLength(4);
    await expect(
      e.inTenant(s.c, (tx) =>
        tx.meterReading.update({
          where: { id: mid.id },
          data: { value: '1' },
        }),
      ),
    ).rejects.toThrow(/a reading never changes/);
  });

  it('a retired meter takes no reading; its readings stay', async () => {
    const m = await e.meter(s);
    await add(m, day(-3), '10');
    await e
      .http('post', `/maintenance/meters/${m.id}/retire`, s.manager.token, {
        reasonCode: 'removed',
      })
      .expect(200);
    expect(err(await post(m, day(-1), '11').expect(409)).code).toBe(
      'METER_RETIRED',
    );
    expect(await live(m)).toHaveLength(1);
  });

  it('a technician records a meter they read and sees its last reading and the range expected, never its history', async () => {
    const m = await e.meter(s, { unitId: s.unit.id, kind: 'electricity' });
    for (const [d, v] of [
      [-40, '1000'],
      [-30, '1100'],
      [-20, '1200'],
      [-10, '1300'],
    ] as const)
      await add(m, day(d), v);
    const tech = s.techs[0];
    const seen = (
      await e.http('get', `/technician/meters/${m.id}`, tech.token).expect(200)
    ).body as Record<string, unknown>;
    expect(seen).toEqual({
      id: m.id,
      code: m.code,
      kind: 'electricity',
      unit: 'kWh',
      mode: 'cumulative',
      unitCode: expect.any(String) as string,
      areaCode: null,
      active: true,
      last: { readOn: day(-10), value: '1300.0000' },
      // 10 a day over 10 days, times the factor 2: up to 200 more.
      expected: { from: '1300.0000', to: '1500.0000' },
    });
    const mine = (
      await e
        .http('post', `/technician/meters/${m.id}/readings`, tech.token, {
          readOn: day(0),
          value: '1410',
        })
        .expect(201)
    ).body as Reading;
    expect(mine).toMatchObject({ source: 'technician', value: '1410.0000' });
    await e
      .http('get', `/maintenance/meters/${m.id}/readings`, tech.token)
      .expect(403);
    await e.http('get', `/maintenance/meters/${m.id}`, tech.token).expect(403);
  });

  describe('races', () => {
    it('two readings of one meter and day: one lands, the other is told the day is taken', async () => {
      for (let round = 0; round < 3; round++) {
        const m = await e.meter(s);
        const results = await Promise.all([
          post(m, day(-1), '10'),
          post(m, day(-1), '11'),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(err(results.find((r) => r.status === 409)!).code).toBe(
          'READING_EXISTS',
        );
        expect(await live(m)).toHaveLength(1);
      }
    });

    it('a backdated reading racing a later one: decided one after the other, both neighbours held for whichever lands second', async () => {
      for (let round = 0; round < 3; round++) {
        const m = await e.meter(s);
        await add(m, day(-20), '100');
        const results = await Promise.all([
          post(m, day(-5), '150'),
          post(m, day(-10), '160'),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
        const refused = err(results.find((r) => r.status === 400)!);
        expect(['READING_ABOVE_NEXT', 'READING_BELOW_PREVIOUS']).toContain(
          refused.fields?.[0]?.code,
        );
        const values = (await live(m)).map((r) => Number(r.value));
        expect(values).toEqual([...values].sort((a, b) => b - a));
      }
    });

    it('two corrections of one reading: one supersedes it, the other is told it is corrected', async () => {
      for (let round = 0; round < 3; round++) {
        const m = await e.meter(s);
        const r = await add(m, day(-3), '10');
        const results = await Promise.all([
          correct(m, r, { value: '11', reasonCode: 'misread' }),
          correct(m, r, { value: '12', reasonCode: 'misread' }),
        ]);
        expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
        expect(err(results.find((x) => x.status === 409)!).code).toBe(
          'READING_ALREADY_CORRECTED',
        );
        expect(await live(m)).toHaveLength(1);
      }
    });
  });
});
