import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { ASSETS_COVERAGE } from '../setup/audit-coverage-split';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import type { Compound } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per entry of the asset register's catalog (ADR 0014, 0064):
 * actor, target, changes and metadata, and never a name the compound
 * wrote, a note, a vendor's contact or a tag.
 */
const covered = new Set<string>();

describe('Audit coverage — assets, plans and inspections', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: AssetSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    read = auditReaders(h);
    s = await a.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('common areas', () => {
    it('common_area.created, .updated and .tag_issued — codes, never the names or the tag', async () => {
      const area = await a.area(s, {
        nameEn: 'AUDIT-secret pump room',
        building: s.building,
        latitude: 30,
        longitude: 31,
      });
      const created = await single(s.c, 'common_area.created', area.id);
      expect(created).toMatchObject({
        actorId: s.manager.id,
        changes: {
          kind: { from: null, to: 'area' },
          code: { from: null, to: area.code },
          building: { from: null, to: s.building },
          nameEn: { changed: true },
          hasPosition: { from: null, to: true },
        },
      });
      await a
        .http('patch', `/maintenance/areas/${area.id}`, s.manager.token, {
          nameEn: 'AUDIT-other',
          active: false,
        })
        .expect(200);
      const updated = await single(s.c, 'common_area.updated', area.id);
      expect(updated.changes).toEqual({
        nameEn: { changed: true },
        active: { from: true, to: false },
      });

      const other = await a.area(s);
      const tag = await a
        .http('post', `/maintenance/areas/${other.id}/tag`, s.manager.token)
        .expect(201);
      const issued = await single(s.c, 'common_area.tag_issued', other.id);
      expect(issued.metadata).toEqual({ replaced: false });
      const token = (tag.body as { code: string }).code.split('.')[2];
      for (const row of [created, updated, issued])
        expect(JSON.stringify(row)).not.toMatch(new RegExp(`AUDIT-|${token}`));
    });
  });

  describe('catalog completeness', () => {
    it('every asset entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of ASSETS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...ASSETS_COVERAGE].sort());
    });
  });
});
