import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  ENGAGEMENT_COVERAGE,
  FACILITIES_COVERAGE,
  FILES_COVERAGE,
  FINANCE_COVERAGE,
  GOVERNANCE_COVERAGE,
  GUARD_DUTY_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  NEIGHBOURS_COVERAGE,
  PARCELS_COVERAGE,
  PATROL_COVERAGE,
  PERMITS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  SECURITY_OPS_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

/**
 * One scenario per security catalog entry of ADR 0053 (ADR 0014): actor,
 * target and metadata — ids, codes and counts by value; never a name, a
 * plate, an ID number or its hash, or what someone wrote.
 */
const covered = new Set<string>();

/** Words typed in every scenario: no audit row may hold them. */
const WORDS = 'Audit-visible security words 5521';

describe('Audit coverage — security (ADR 0053)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Security Audit Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) expect(leakText(row)).not.toContain(WORDS);
    return found;
  }
  async function single(action: string, targetId: string) {
    const found = await rows(action, targetId);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });

  describe('the lockdown', () => {
    it('started, overridden and ended: scope, codes, shift and counts; the end’s note only as whether there was one', async () => {
      const gate = await x.g.gate(s.c);
      const guard = await x.guardAt(s.c, gate.id);
      const l = await x.lockdown(guard, {
        scope: 'gate',
        gateId: gate.id,
        reasonCode: 'drill',
      });
      const started = await single('gate_lockdown.started', l.id);
      expect(started).toMatchObject(by(guard, 'gate_lockdown'));
      expect(started.metadata).toEqual({
        scope: 'gate',
        gateId: gate.id,
        reasonCode: 'drill',
        shiftId: guard.shiftId,
        recipients: 1,
        residents: 1,
      });
      const o = (
        await x
          .http('post', `/gate/lockdowns/${l.id}/overrides`, guard.token, {
            reasonCode: 'fire_truck',
          })
          .expect(201)
      ).body as { id: string };
      const override = await single('gate_lockdown.override', l.id);
      expect(override).toMatchObject(by(guard, 'gate_lockdown'));
      expect(override.metadata).toEqual({
        overrideId: o.id,
        gateId: gate.id,
        shiftId: guard.shiftId,
        kind: 'fire_truck',
        emergencyId: null,
        gateServiceRequestId: null,
      });
      await x
        .endLockdownRaw(s.manager, l.id, {
          reasonCode: 'drill_over',
          note: WORDS,
        })
        .expect(200);
      const ended = await single('gate_lockdown.ended', l.id);
      expect(ended).toMatchObject(by(s.manager, 'gate_lockdown'));
      expect(ended.metadata).toEqual({
        scope: 'gate',
        gateId: gate.id,
        reasonCode: 'drill_over',
        note: true,
        recipients: 1,
        residents: 1,
      });
    });
  });

  describe('catalog completeness', () => {
    it('every security entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of SECURITY_OPS_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
          ...R1_COVERAGE,
          ...RESIDENT_SCREENS_COVERAGE,
          ...MANAGEMENT_COVERAGE,
          ...ENGAGEMENT_COVERAGE,
          ...NEIGHBOURS_COVERAGE,
          ...FACILITIES_COVERAGE,
          ...VEHICLES_COVERAGE,
          ...FINANCE_COVERAGE,
          ...SAFETY_COVERAGE,
          ...PERMITS_COVERAGE,
          ...GUARD_DUTY_COVERAGE,
          ...GOVERNANCE_COVERAGE,
          ...PATROL_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...SECURITY_OPS_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter((k) =>
            /^(gate_lockdown|blocklist|incident|violation|unit_violation|permit_work)[a-z_]*\./.test(
              k,
            ),
          )
          .sort(),
      ).toEqual([...SECURITY_OPS_COVERAGE].sort());
    });
  });
});
