import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M23_COVERAGE } from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { neighboursHelpers, type NeighboursSetUp } from '../setup/neighbours';

/**
 * One scenario per entry of the staff inbox's, the authority's and the
 * deputies' catalog (ADR 0014, 0073): actor, target, and what changed —
 * types, hours, permissions and days, never a person's words.
 */
const covered = new Set<string>();

describe('Audit coverage — the inbox, the authority and the deputies', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: NeighboursSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    read = auditReaders(h);
    s = await n.setUp();
  }, 90_000);

  afterAll(() => h.close());

  describe('the staff inbox', () => {
    it('staff_inbox.settings_changed — each type’s due hours, from and to', async () => {
      await n
        .http('patch', '/staff/inbox/settings', s.manager.token, {
          items: [{ type: 'vehicle', dueHours: 12 }],
        })
        .expect(200);
      const rows = await read.tenant(s.c.tenantId, {
        action: 'staff_inbox.settings_changed',
        targetId: s.c.tenantId,
      });
      expect(rows).toHaveLength(1);
      covered.add('staff_inbox.settings_changed');
      expect(rows[0]).toMatchObject({
        actorId: s.manager.id,
        changes: { 'vehicle.dueHours': { from: 72, to: 12 } },
      });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the phase has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M23_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M23_COVERAGE].sort());
    });
  });
});
