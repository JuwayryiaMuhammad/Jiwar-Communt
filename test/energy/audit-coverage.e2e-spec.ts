import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { ENERGY_COVERAGE } from '../setup/audit-coverage-split';
import type { Compound } from '../setup/community';
import { day } from '../setup/compound-clock';
import { energyHelpers, type EnergySetUp } from '../setup/energy';
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

  describe('catalog completeness', () => {
    it('every energy entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of ENERGY_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...ENERGY_COVERAGE].sort());
    });
  });
});
