import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { M21_COVERAGE } from '../setup/audit-coverage-split';
import type { Compound } from '../setup/community';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { unitsHelpers, type Who } from '../setup/units';

/**
 * One scenario per entry of the unit register's catalog (ADR 0014, 0072):
 * actor, target and what changed — a building's name, a unit's facts,
 * counts — never a person's details.
 */
const covered = new Set<string>();

describe('Audit coverage — the unit register', () => {
  let h: HttpHarness;
  let u: ReturnType<typeof unitsHelpers>;
  let c: Compound;
  let manager: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    u = unitsHelpers(h);
    ({ c, manager } = await u.setUp('Audit Register Court'));
  }, 90_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await u.audits.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  it('building.created and building.deleted — the name', async () => {
    const name = `Audit ${uniqueSuffix()}`;
    const b = await u.building(manager, name);
    expect(await single('building.created', b.id)).toMatchObject({
      actorId: manager.id,
      targetType: 'building',
      metadata: { name },
    });
    await u.http('delete', `/buildings/${b.id}`, manager.token).expect(204);
    expect(await single('building.deleted', b.id)).toMatchObject({
      actorId: manager.id,
      targetType: 'building',
      metadata: { name },
    });
  });

  it('unit.updated — building, floor, type and area, from and to', async () => {
    const unit = await u.newUnit(manager, { floor: 1 });
    await u.edit(manager, unit.id, { floor: 4, areaSqm: '80' }).expect(200);
    expect(await single('unit.updated', unit.id)).toMatchObject({
      actorId: manager.id,
      targetType: 'unit',
      changes: {
        floor: { from: 1, to: 4 },
        areaSqm: { from: null, to: '80.00' },
      },
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the unit register has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M21_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M21_COVERAGE].sort());
    });
  });
});
