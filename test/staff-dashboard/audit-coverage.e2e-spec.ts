import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M24_COVERAGE } from '../setup/audit-coverage-split';
import { today } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

const MARKER = 'AUDIT-m24-secret';

/**
 * One scenario per entry of the operations dashboard's catalog (ADR 0014,
 * 0079): actor, target and what changed — times, a threshold, the days and
 * counts of an export, never a visitor's name.
 */
const covered = new Set<string>();

describe('Audit coverage — the operations dashboard', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    read = auditReaders(h);
    s = await d.setUp(0);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string) {
    const rows = await read.tenant(s.c.tenantId, {
      action,
      targetId: s.c.tenantId,
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    expect(rows[0].actorId).toBe(s.manager.id);
    covered.add(action);
    return rows[0];
  }

  it('staff_dashboard.settings_changed — the times from and to', async () => {
    await d
      .http('patch', '/staff/dashboard/settings', s.manager.token, {
        briefAt: '06:45',
      })
      .expect(200);
    expect((await single('staff_dashboard.settings_changed')).changes).toEqual({
      briefAt: { from: '07:00', to: '06:45' },
    });
  });

  it('maintenance.service_pressure_changed — the threshold from and to', async () => {
    await d
      .http('patch', '/maintenance/service-pressure', s.manager.token, {
        openPerTechnician: 6,
      })
      .expect(200);
    expect(
      (await single('maintenance.service_pressure_changed')).changes,
    ).toEqual({ openPerTechnician: { from: null, to: 6 } });
  });

  it('gate.log_exported — the days, the unit, whether by name and the rows; never the name', async () => {
    await d
      .http('post', '/staff/gate/log-search/export', s.manager.token, {
        from: today(),
        to: today(),
        visitorName: `${MARKER} Someone`,
      })
      .expect(200);
    expect((await single('gate.log_exported')).metadata).toEqual({
      from: today(),
      to: today(),
      unitId: null,
      byName: true,
      rows: 0,
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the operations dashboard has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M24_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M24_COVERAGE].sort());
    });
  });
});
