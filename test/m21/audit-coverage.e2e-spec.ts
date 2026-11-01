import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { UNIT_IMPORTS_SWEEP } from '../../src/community/units/unit-imports.service';
import { daysLater } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
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

  it('unit_import.checked, .applied and .expired — kind and counts, never a cell', async () => {
    const files = fileHelpers(h);
    const upload = async (text: string) => {
      const id = await files.uploaded(
        manager.token,
        'data_import',
        'text/csv',
        Buffer.from(text, 'utf8'),
      );
      await files.finalize(manager.token, id).expect(200);
      return id;
    };
    const code = `AUD${uniqueSuffix()}`;
    const checked = (
      await u
        .http('post', '/staff/unit-imports', manager.token, {
          kind: 'units',
          fileId: await upload(`code\r\n${code}`),
        })
        .expect(201)
    ).body as { id: string };
    expect(await single('unit_import.checked', checked.id)).toMatchObject({
      actorId: manager.id,
      targetType: 'unit_import',
      metadata: { kind: 'units', rowCount: 1, errorCount: 0 },
    });
    await u
      .http('post', `/staff/unit-imports/${checked.id}/apply`, manager.token)
      .expect(201);
    const applied = await single('unit_import.applied', checked.id);
    expect(applied).toMatchObject({
      actorId: manager.id,
      metadata: { kind: 'units', created: 1 },
    });
    expect(JSON.stringify(applied)).not.toContain(code);
    const later = (
      await u
        .http('post', '/staff/unit-imports', manager.token, {
          kind: 'units',
          fileId: await upload(`code\r\n${code}-2`),
        })
        .expect(201)
    ).body as { id: string };
    await h.moduleRef.get(SweepRunner).run(UNIT_IMPORTS_SWEEP, daysLater(2));
    expect(await single('unit_import.expired', later.id)).toMatchObject({
      actorType: 'system',
      metadata: { kind: 'units' },
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
