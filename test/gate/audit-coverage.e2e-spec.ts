import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { GatesService } from '../../src/gate/gates/gates.service';
import { ShiftsService } from '../../src/gate/shifts/shifts.service';
import { InstructionsService } from '../../src/gate/visitors/instructions.service';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
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

  describe('visitors', () => {
    it('visitor_pass.created, code_reissued, cancelled — never a name, phone or code', async () => {
      const c = await x.compound();
      const unit = await x.unit(c);
      const host = await x.resident(c, [unit.id]);
      const passes = h.moduleRef.get(VisitorPassesService);
      const asHost = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: host.id, type: 'resident' }, fn);
      const input = {
        kind: 'one_time' as const,
        partySize: 3,
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 3_600_000),
        visitorName: 'Audit Guest',
        visitorPhone: '+201011112222',
      };
      const pass = await asHost(() =>
        passes.create(unit.id, input, 'audit-key-1'),
      );
      const created = await single(c, 'visitor_pass.created', pass.id);
      expect(created).toMatchObject({
        actorType: 'account',
        actorId: host.id,
        targetType: 'visitor_pass',
        metadata: { unitId: unit.id, kind: 'one_time', partySize: 3 },
      });
      const again = await asHost(() =>
        passes.create(unit.id, input, 'audit-key-1'),
      );
      const reissued = await single(c, 'visitor_pass.code_reissued', pass.id);
      expect(reissued).toMatchObject({
        actorId: host.id,
        metadata: { reason: 'idempotent_replay' },
      });
      await asHost(() => passes.cancel(pass.id, 'plans_changed'));
      const cancelled = await single(c, 'visitor_pass.cancelled', pass.id);
      expect(cancelled).toMatchObject({
        actorId: host.id,
        metadata: { reasonCode: 'plans_changed' },
      });
      const trail = JSON.stringify([created, reissued, cancelled]);
      for (const secret of [
        'Audit Guest',
        '+201011112222',
        pass.code!,
        again.code!,
      ])
        expect(trail).not.toContain(secret);
    });

    it('gate.instructions_changed — by the primary, on the unit', async () => {
      const c = await x.compound();
      const unit = await x.unit(c);
      const host = await x.resident(c, [unit.id]);
      await x.as(c, { id: host.id, type: 'resident' }, () =>
        h.moduleRef
          .get(InstructionsService)
          .set(unit.id, { uninvitedVisitor: 'deny', delivery: 'ask' }),
      );
      expect(
        await single(c, 'gate.instructions_changed', unit.id),
      ).toMatchObject({
        actorId: host.id,
        targetType: 'unit',
        changes: { uninvitedVisitor: { from: 'ask', to: 'deny' } },
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
