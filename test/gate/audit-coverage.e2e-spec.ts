import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { GatesService } from '../../src/gate/gates/gates.service';
import { ShiftsService } from '../../src/gate/shifts/shifts.service';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
} from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per Phase 4 catalog entry (ADR 0014, 0028): actor, target,
 * changes and metadata — and never a visitor's name, phone or code.
 */
const covered = new Set<string>();

describe('Audit coverage — the gate', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let g: ReturnType<typeof gateHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    g = gateHelpers(h);
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('gates and shifts', () => {
    it('gate.created and gate.updated — by the manager', async () => {
      const c = await x.compound();
      const gate = await g.gate(c, 'Main');
      expect(await single(c, 'gate.created', gate.id)).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'gate',
        changes: {
          name: { from: null, to: 'Main' },
          kind: { from: null, to: 'mixed' },
          status: { from: null, to: 'active' },
        },
      });
      await x.asManager(c, () =>
        h.moduleRef.get(GatesService).update(gate.id, { kind: 'vehicle' }),
      );
      expect(await single(c, 'gate.updated', gate.id)).toMatchObject({
        actorId: c.managerId,
        changes: { kind: { from: 'mixed', to: 'vehicle' } },
      });
    });

    it('gate.shift_started and gate.shift_ended — by the guard', async () => {
      const c = await x.compound();
      const duty = await g.onDuty(c);
      expect(await single(c, 'gate.shift_started', duty.shiftId)).toMatchObject(
        {
          actorType: 'account',
          actorId: duty.guardId,
          targetType: 'guard_shift',
          metadata: { gateId: duty.gateId },
        },
      );
      await x.as(c, { id: duty.guardId, type: 'staff' }, () =>
        h.moduleRef.get(ShiftsService).end(),
      );
      expect(await single(c, 'gate.shift_ended', duty.shiftId)).toMatchObject({
        actorId: duty.guardId,
        metadata: { reason: 'guard' },
      });
    });
  });

  describe('catalog completeness', () => {
    it('every Phase 4 entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PHASE_4_COVERAGE) {
        expect(all).toContain(key);
        expect([...COMMUNITY_COVERAGE, ...PHASE_2_2_COVERAGE]).not.toContain(
          key,
        );
      }
      expect([...covered].sort()).toEqual([...PHASE_4_COVERAGE].sort());
    });
  });
});
