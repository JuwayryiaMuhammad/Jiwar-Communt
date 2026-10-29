import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { ENERGY_COVERAGE } from '../setup/audit-coverage-split';
import type { Compound } from '../setup/community';
import { day } from '../setup/compound-clock';
import { energyHelpers, type EnergySetUp } from '../setup/energy';
import { fileHelpers } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per entry of the energy catalog (ADR 0014, 0066): actor,
 * target, changes and metadata — codes, kinds, ids, days and values, and
 * nothing that names a person.
 */
const covered = new Set<string>();

describe('Audit coverage — energy and utilities', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof energyHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: EnergySetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = energyHelpers(h);
    read = auditReaders(h);
    s = await e.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('meters', () => {
    it('meter.created, .updated and .retired — the measure, the place, the days and the reason', async () => {
      const m = await e.meter(s, {
        unitId: s.unit.id,
        kind: 'electricity',
        multiplier: '2',
        serial: 'SN-1',
      });
      expect(await single(s.c, 'meter.created', m.id)).toMatchObject({
        actorId: s.manager.id,
        changes: {
          code: { from: null, to: m.code },
          kind: { from: null, to: 'electricity' },
          mode: { from: null, to: 'cumulative' },
          multiplier: { from: null, to: '2.0000' },
          unitId: { from: null, to: s.unit.id },
          serial: { from: null, to: 'SN-1' },
          active: { from: null, to: true },
        },
      });
      await e
        .http('patch', `/maintenance/meters/${m.id}`, s.manager.token, {
          installedOn: day(-2),
        })
        .expect(200);
      expect((await single(s.c, 'meter.updated', m.id)).changes).toEqual({
        installedOn: { from: null, to: day(-2) },
      });
      await e
        .http('post', `/maintenance/meters/${m.id}/retire`, s.manager.token, {
          reasonCode: 'replaced',
        })
        .expect(200);
      expect((await single(s.c, 'meter.retired', m.id)).metadata).toEqual({
        reasonCode: 'replaced',
      });
    });
  });

  describe('readings, alerts and the spike rule', () => {
    it('meter_reading.corrected and .withdrawn, meter_alert.acknowledged, energy.settings_changed — ids, days, values and codes', async () => {
      const m = await e.meter(s);
      const post = (readOn: string, value: string) =>
        e
          .http(
            'post',
            `/maintenance/meters/${m.id}/readings`,
            s.manager.token,
            {
              readOn,
              value,
            },
          )
          .expect(201);
      const first = (await post(day(-50), '900')).body as { id: string };
      await post(day(-40), '1000');
      await post(day(-30), '1100');
      await post(day(-20), '1200');
      await post(day(-10), '1300');
      const fixed = (
        await e
          .http(
            'post',
            `/maintenance/meters/${m.id}/readings/${first.id}/correct`,
            s.manager.token,
            { value: '890', reasonCode: 'misread' },
          )
          .expect(201)
      ).body as { id: string };
      expect(
        await single(s.c, 'meter_reading.corrected', fixed.id),
      ).toMatchObject({
        actorId: s.manager.id,
        metadata: {
          meterId: m.id,
          supersedesId: first.id,
          readOn: day(-50),
          value: '890.0000',
          reset: false,
          reasonCode: 'misread',
        },
      });
      await e
        .http(
          'post',
          `/maintenance/meters/${m.id}/readings/${fixed.id}/withdraw`,
          s.manager.token,
          { reasonCode: 'wrong_meter' },
        )
        .expect(200);
      expect(
        (await single(s.c, 'meter_reading.withdrawn', fixed.id)).metadata,
      ).toEqual({ meterId: m.id, readOn: day(-50), reasonCode: 'wrong_meter' });
      await e
        .http('post', `/maintenance/meters/${m.id}/readings`, s.manager.token, {
          readOn: day(0),
          value: '2000',
        })
        .expect(201);
      const alert = (
        (
          await e
            .http(
              'get',
              `/maintenance/meter-alerts?meterId=${m.id}`,
              s.manager.token,
            )
            .expect(200)
        ).body as { data: { id: string }[] }
      ).data[0];
      await e
        .http(
          'post',
          `/maintenance/meter-alerts/${alert.id}/acknowledge`,
          s.supervisor.token,
        )
        .expect(200);
      expect(
        await single(s.c, 'meter_alert.acknowledged', alert.id),
      ).toMatchObject({
        actorId: s.supervisor.id,
        metadata: { meterId: m.id },
      });
      await e
        .http('patch', '/maintenance/energy/settings', s.manager.token, {
          anomalyFactor: '3',
        })
        .expect(200);
      expect(
        (await single(s.c, 'energy.settings_changed', s.c.tenantId)).changes,
      ).toEqual({ anomalyFactor: { from: '2.00', to: '3.00' } });
    });
  });

  describe('reading imports', () => {
    it('meter_reading_import.checked and .applied — the file, the counts, never a cell', async () => {
      const m = await e.meter(s);
      const files = fileHelpers(h);
      const fileId = await files.uploaded(
        s.manager.token,
        'data_import',
        'text/csv',
        Buffer.from(`meter,read_on,value\n${m.code},${day(-1)},42\n`),
      );
      await files.finalize(s.manager.token, fileId).expect(200);
      const checked = (
        await e
          .http('post', '/maintenance/meter-reading-imports', s.manager.token, {
            fileId,
          })
          .expect(201)
      ).body as { id: string };
      expect(
        (await single(s.c, 'meter_reading_import.checked', checked.id))
          .metadata,
      ).toEqual({ fileId, rowCount: 1, errorCount: 0 });
      await e
        .http(
          'post',
          `/maintenance/meter-reading-imports/${checked.id}/apply`,
          s.manager.token,
        )
        .expect(200);
      expect(
        (await single(s.c, 'meter_reading_import.applied', checked.id))
          .metadata,
      ).toEqual({ created: 1 });
      const rows = await read.tenant(s.c.tenantId, { targetId: checked.id });
      expect(JSON.stringify(rows)).not.toContain(m.code);
    });
  });

  describe('catalog completeness', () => {
    it('every energy entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of ENERGY_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...ENERGY_COVERAGE].sort());
    });
  });
});
