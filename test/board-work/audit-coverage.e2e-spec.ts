import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { BOARD_WORK_COVERAGE } from '../setup/audit-coverage-split';
import { governanceHelpers } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-board-work-secret';

/**
 * One scenario per entry of the board's work (ADR 0014, 0075): actor,
 * target and what changed — ids, codes, dates and counts; never a
 * meeting's words, an action's, a minute's or a handover's notes.
 */
const covered = new Set<string>();

describe('Audit coverage — the board’s work', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    read = auditReaders(h);
    s = await g.setUp(4);
    await g.appoint(s.manager, s.owners.slice(0, 3));
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  describe('ownership shares', () => {
    it('governance_unit_share.changed — the unit, the share before and after', async () => {
      const unitId = s.owners[3].unitId;
      await g
        .http('put', '/staff/governance/unit-shares', s.manager.token, {
          shares: [{ unitId, share: '12.5' }],
        })
        .expect(200);
      expect(
        await single('governance_unit_share.changed', unitId),
      ).toMatchObject({
        actorId: s.manager.id,
        targetType: 'unit',
        changes: { share: { from: null, to: '12.5000' } },
      });
    });
  });

  describe('the rules', () => {
    it('governance_rules.changed — on the compound, the rules by value', async () => {
      await g
        .http('patch', '/staff/governance/rules', s.manager.token, {
          candidacyNotStaff: true,
        })
        .expect(200);
      expect(
        await single('governance_rules.changed', s.c.tenantId),
      ).toMatchObject({
        actorId: s.manager.id,
        targetType: 'tenant',
        changes: { candidacyNotStaff: { from: false, to: true } },
      });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the board’s work has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of BOARD_WORK_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...BOARD_WORK_COVERAGE].sort());
    });
  });
});
