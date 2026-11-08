import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M34_COVERAGE } from '../setup/audit-coverage-split';
import { financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per entry of cash flow's catalog (ADR 0014, 0091): the
 * actor, the compound and the floor from and to.
 */
const covered = new Set<string>();

describe('Audit coverage — cash flow', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof financeHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    read = auditReaders(h);
    s = await f.setUp('Cash Flow Audit Court');
  }, 90_000);

  afterAll(() => h.close());

  it('cash_flow.settings_changed — the floor from and to, by who keeps the treasury; no change, no entry', async () => {
    const patch = (minimumCash: string | null) =>
      f
        .http(
          'patch',
          '/staff/finance/cash-flow/settings',
          s.accountant.token,
          {
            minimumCash,
          },
        )
        .expect(200);
    await patch('25000.5');
    await patch('25000.50');
    await patch(null);
    const rows = await read.tenant(s.c.tenantId, {
      action: 'cash_flow.settings_changed',
      targetId: s.c.tenantId,
    });
    expect(rows.map((r) => [r.actorId, r.changes])).toEqual([
      [s.accountant.id, { minimumCash: { from: null, to: '25000.50' } }],
      [s.accountant.id, { minimumCash: { from: '25000.50', to: null } }],
    ]);
    covered.add('cash_flow.settings_changed');
  });

  describe('catalog completeness', () => {
    it('every entry of cash flow has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M34_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M34_COVERAGE].sort());
    });
  });
});
