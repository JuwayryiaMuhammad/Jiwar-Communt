import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import {
  energyHelpers,
  type EnergySetUp,
  type MeterRead,
} from '../setup/energy';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Alert {
  id: string;
  meterId: string;
  readOn: string;
  kind: string;
  dailyRate: string;
  baselineRate: string;
  acknowledgedAt: string | null;
}

/**
 * ADR 0066: a spike — the latest period's daily use above the mean of the
 * compound's number of periods before it times its factor — raised once
 * per meter and day to who keeps the meters, never by a backdated
 * reading, acknowledged once.
 */
describe('Energy — spikes', () => {
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
    e.http('post', `/maintenance/meters/${m.id}/readings`, s.manager.token, {
      readOn,
      value,
    });
  /** 10 a day for three periods of ten days: a mean of 10, ending at 1300 on day -10. */
  async function steady(m: MeterRead) {
    for (const [d, v] of [
      [-40, '1000'],
      [-30, '1100'],
      [-20, '1200'],
      [-10, '1300'],
    ] as const)
      await post(m, day(d), v).expect(201);
  }
  const alerts = async (m: MeterRead) =>
    (
      (
        await e
          .http(
            'get',
            `/maintenance/meter-alerts?meterId=${m.id}`,
            s.supervisor.token,
          )
          .expect(200)
      ).body as { data: Alert[] }
    ).data;
  const notices = (accountId: string, targetId: string) =>
    e.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId, kind: 'meter.anomaly', targetId },
      }),
    );

  it('a period above the mean times the factor is a spike, told once to who keeps the meters', async () => {
    const m = await e.meter(s, { kind: 'electricity' });
    await steady(m);
    // 2× the mean is not above it: no spike.
    await post(m, day(-5), '1400').expect(201);
    expect(await alerts(m)).toEqual([]);
    // 60 a day over 5 days against the mean before it, 400 over 35 days: a spike.
    await post(m, day(0), '1700').expect(201);
    const [alert] = await alerts(m);
    expect(alert).toMatchObject({
      kind: 'spike',
      readOn: day(0),
      dailyRate: '60.0000',
      baselineRate: '11.4286',
      acknowledgedAt: null,
    });
    for (const keeper of [s.manager, s.supervisor]) {
      const told = await notices(keeper.id, m.id);
      expect(told).toHaveLength(1);
      expect(told[0].params).toEqual({ meterRef: m.code, readOn: day(0) });
    }
    expect(await notices(s.techs[0].id, m.id)).toHaveLength(0);
  });

  it('a backdated reading raises nothing; without three periods there is no mean', async () => {
    const m = await e.meter(s);
    await post(m, day(-40), '0').expect(201);
    await post(m, day(-30), '1').expect(201);
    await post(m, day(-20), '500').expect(201);
    expect(await alerts(m)).toEqual([]);
    const n = await e.meter(s);
    await steady(n);
    await post(n, day(-5), '1350').expect(201);
    // Backdated, and far above its period's mean: it is not the latest.
    await post(n, day(-12), '1290').expect(201);
    expect(await alerts(n)).toEqual([]);
  });

  it('acknowledged once; the spike rule is the compound’s to change', async () => {
    await e
      .http('patch', '/maintenance/energy/settings', s.supervisor.token, {
        anomalyFactor: '5',
        anomalyPeriods: 3,
      })
      .expect(200);
    try {
      const m = await e.meter(s);
      await steady(m);
      // 30 a day: three times the mean, under five times.
      await post(m, day(0), '1600').expect(201);
      expect(await alerts(m)).toEqual([]);
      const n = await e.meter(s);
      await steady(n);
      await post(n, day(0), '2000').expect(201);
      const [alert] = await alerts(n);
      const ack = () =>
        e.http(
          'post',
          `/maintenance/meter-alerts/${alert.id}/acknowledge`,
          s.supervisor.token,
        );
      expect(((await ack().expect(200)).body as Alert).acknowledgedAt).not.toBe(
        null,
      );
      expect(err(await ack().expect(409)).code).toBe(
        'METER_ALERT_ACKNOWLEDGED',
      );
      await e
        .http(
          'post',
          `/maintenance/meter-alerts/${alert.id}/acknowledge`,
          s.techs[0].token,
        )
        .expect(403);
      expect(
        err(
          await e
            .http('patch', '/maintenance/energy/settings', s.manager.token, {
              anomalyFactor: '11',
            })
            .expect(400),
        ).fields,
      ).toEqual([
        {
          field: 'anomalyFactor',
          code: 'INVALID_NUMBER',
          params: { min: 1.2, max: 10 },
        },
      ]);
    } finally {
      await e
        .http('patch', '/maintenance/energy/settings', s.manager.token, {
          anomalyFactor: '2',
          anomalyPeriods: 6,
        })
        .expect(200);
    }
  });

  it('race: the spike reading sent twice at once lands once, and is told once', async () => {
    for (let round = 0; round < 3; round++) {
      const m = await e.meter(s);
      await steady(m);
      const results = await Promise.all([
        post(m, day(0), '2000'),
        post(m, day(0), '2000'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await alerts(m)).toHaveLength(1);
      expect(await notices(s.manager.id, m.id)).toHaveLength(1);
    }
  });
});
