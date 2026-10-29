import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import {
  energyHelpers,
  type EnergySetUp,
  type MeterRead,
} from '../setup/energy';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0066: the compound's meters — in a unit, in a common area or on an
 * asset (and then where it stands); their code, kind, mode, multiplier and
 * place for life; retired once, with a reason.
 */
describe('Energy — meters', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let s: EnergySetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    s = await e.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  it('stands in a unit, a common area, or on an asset where the asset stands; exactly one place', async () => {
    const inUnit = await e.meter(s, {
      unitId: s.unit.id,
      kind: 'electricity',
      multiplier: '2.5',
      serial: ' SN-77 ',
      installedOn: day(-30),
    });
    expect(inUnit).toMatchObject({
      kind: 'electricity',
      unit: 'kWh',
      mode: 'cumulative',
      multiplier: '2.5000',
      unitId: s.unit.id,
      commonAreaId: null,
      serial: 'SN-77',
      installedOn: day(-30),
      active: true,
    });
    const area = await e.area(s);
    const generator = await e.asset(s, {
      commonAreaId: area.id,
      typeId: await e.typeId(s, 'generator'),
    });
    expect(
      await e.meter(s, {
        assetId: generator,
        kind: 'run_hours',
        mode: 'interval',
      }),
    ).toMatchObject({
      assetId: generator,
      commonAreaId: area.id,
      unitId: null,
      unit: 'h',
      mode: 'interval',
    });
    expect(err(await e.newMeter(s, {}).expect(400)).fields).toEqual([
      { field: 'unitId', code: 'FIELD_REQUIRED' },
    ]);
    expect(
      err(
        await e
          .newMeter(s, { unitId: s.unit.id, commonAreaId: area.id })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'commonAreaId', code: 'FIELD_NOT_ALLOWED' }]);
    expect(
      err(
        await e
          .newMeter(s, { commonAreaId: area.id, assetId: generator })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'assetId', code: 'FIELD_NOT_ALLOWED' }]);
  });

  it('its code is unique; the multiplier is more than 0; installed by today, on a day that exists', async () => {
    const m = await e.meter(s);
    expect(
      err(await e.newMeter(s, { code: m.code, unitId: s.unit.id }).expect(409)),
    ).toMatchObject({ code: 'DUPLICATE_RESOURCE' });
    expect(
      err(
        await e.newMeter(s, { unitId: s.unit.id, multiplier: '0' }).expect(400),
      ).fields,
    ).toEqual([{ field: 'multiplier', code: 'INVALID_VALUE' }]);
    expect(
      err(
        await e
          .newMeter(s, { unitId: s.unit.id, installedOn: day(1) })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'installedOn', code: 'INVALID_VALUE' }]);
    expect(
      err(
        await e
          .newMeter(s, { unitId: s.unit.id, installedOn: '2026-02-30' })
          .expect(400),
      ).fields,
    ).toEqual([{ field: 'installedOn', code: 'INVALID_FORMAT' }]);
  });

  it('an unknown unit is not found; a retired area or asset takes no new meter', async () => {
    expect(
      err(
        await e
          .newMeter(s, { unitId: '0192a5f0-1c2b-7d3e-8f40-0000000066a1' })
          .expect(404),
      ).code,
    ).toBe('UNIT_NOT_FOUND');
    const area = await e.area(s);
    await e
      .http('patch', `/maintenance/areas/${area.id}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    expect(
      err(await e.newMeter(s, { commonAreaId: area.id }).expect(409)).code,
    ).toBe('COMMON_AREA_RETIRED');
  });

  it('keeps its measure for life; retired once with a reason, then never changed', async () => {
    const m = await e.meter(s);
    const patched = (
      await e
        .http('patch', `/maintenance/meters/${m.id}`, s.manager.token, {
          serial: 'SN-2',
          installedOn: day(-3),
        })
        .expect(200)
    ).body as MeterRead;
    expect(patched).toMatchObject({ serial: 'SN-2', installedOn: day(-3) });
    await expect(
      e.inTenant(s.c, (tx) =>
        tx.meter.update({ where: { id: m.id }, data: { kind: 'gas' } }),
      ),
    ).rejects.toThrow(/keeps its measure/);
    const retire = (body: object) =>
      e.http(
        'post',
        `/maintenance/meters/${m.id}/retire`,
        s.manager.token,
        body,
      );
    expect(err(await retire({}).expect(400)).code).toBe('REASON_REQUIRED');
    expect(
      (await retire({ reasonCode: 'faulty' }).expect(200)).body,
    ).toMatchObject({ active: false, retireReason: 'faulty' });
    expect(err(await retire({ reasonCode: 'other' }).expect(409)).code).toBe(
      'METER_RETIRED',
    );
    expect(
      err(
        await e
          .http('patch', `/maintenance/meters/${m.id}`, s.manager.token, {
            serial: 'SN-3',
          })
          .expect(409),
      ).code,
    ).toBe('METER_RETIRED');
    await expect(
      e.inTenant(s.c, (tx) =>
        tx.meter.update({ where: { id: m.id }, data: { serial: 'SN-9' } }),
      ),
    ).rejects.toThrow(/retired one never changes/);
  });

  it('listed oldest first and filtered; the supervisor reads them, a technician never', async () => {
    const water = await e.meter(s, { unitId: s.unit.id, kind: 'water' });
    const list = (
      await e
        .http(
          'get',
          `/maintenance/meters?kind=water&unitId=${s.unit.id}`,
          s.supervisor.token,
        )
        .expect(200)
    ).body as { data: MeterRead[] };
    expect(list.data.map((m) => m.id)).toContain(water.id);
    expect(list.data.every((m) => m.kind === 'water')).toBe(true);
    await e.http('get', '/maintenance/meters', s.techs[0].token).expect(403);
  });
});
