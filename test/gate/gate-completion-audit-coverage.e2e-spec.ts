import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import * as split from '../setup/audit-coverage-split';
import { gateCompletionHelpers, type Who } from '../setup/gate-completion';
import { today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';

/**
 * One scenario per catalog entry of ADR 0056 (ADR 0014): actor, target and
 * metadata — ids, codes and counts by value; never a visitor's name, a
 * plate or an ID number.
 */
const covered = new Set<string>();

const NAME = 'Audit-visible exception visitor 7712';
const PLATE = 'ع ق 7712';

describe('Audit coverage — the gate’s completion (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Gate Completion Audit Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    const text = leakText(found);
    for (const secret of [NAME, PLATE, PLATE.replace(/\s/g, '')])
      expect(text).not.toContain(secret);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });

  it('gate_settings.changed: what changed, from and to', async () => {
    await g
      .http('patch', '/staff/gate/settings', s.manager.token, {
        exceptionEntryMinutes: 20,
      })
      .expect(200);
    const row = await single('gate_settings.changed', s.c.tenantId);
    expect(row).toMatchObject(by(s.manager, 'tenant'));
    expect(row.changes).toEqual({
      exceptionEntryMinutes: { from: 15, to: 20 },
    });
  });

  it('gate_exception.raised and .decided: codes and ids, the name and plate as booleans', async () => {
    const x = await g.raise(s.guard, {
      kind: 'unregistered_vehicle',
      unitCode: s.unitCode,
      visitorName: NAME,
      vehiclePlate: PLATE,
    });
    const raised = await single('gate_exception.raised', x.id);
    expect(raised).toMatchObject(by(s.guard, 'gate_field_exception'));
    expect(raised.metadata).toEqual({
      number: expect.any(Number) as number,
      kind: 'unregistered_vehicle',
      reasonCode: 'resident_unreachable',
      unitId: s.home.id,
      gateId: s.guard.gateId,
      shiftId: s.guard.shiftId,
      visitorName: true,
      withPlate: true,
    });
    await g
      .decideRaw(s.manager, x.id, {
        decision: 'reject',
        reasonCode: 'not_expected',
      })
      .expect(200);
    const decided = await single('gate_exception.decided', x.id);
    expect(decided).toMatchObject(by(s.manager, 'gate_field_exception'));
    expect(decided.metadata).toEqual({
      decision: 'rejected',
      rejectReasonCode: 'not_expected',
    });
  });

  it('gate_exception.expired: by the system; .withdrawn: by the guard', async () => {
    const late = await g.visitor(s.guard, s.unitCode);
    await g.pastDeadline(late.id);
    await g.sweepExceptions();
    const expired = await single('gate_exception.expired', late.id);
    expect(expired).toMatchObject({
      actorType: 'system',
      actorId: null,
      targetType: 'gate_field_exception',
    });
    const back = await g.visitor(s.guard, s.unitCode);
    await g
      .http('post', `/gate/field-exceptions/${back.id}/withdraw`, s.guard.token)
      .expect(200);
    const withdrawn = await single('gate_exception.withdrawn', back.id);
    expect(withdrawn).toMatchObject(by(s.guard, 'gate_field_exception'));
  });

  it('service_vehicle.entered, .exited and .exit_unconfirmed: never the plate nor the company', async () => {
    const v = await g.serviceIn(s.guard, PLATE, { company: NAME });
    const entered = await single('service_vehicle.entered', v.id);
    expect(entered).toMatchObject(by(s.guard, 'service_vehicle_visit'));
    expect(entered.metadata).toEqual({
      kind: 'tanker',
      unitId: null,
      facilityId: null,
      gateId: s.guard.gateId,
      shiftId: s.guard.shiftId,
    });
    await g.serviceOutRaw(s.guard, v.id).expect(200);
    const exited = await single('service_vehicle.exited', v.id);
    expect(exited).toMatchObject(by(s.guard, 'service_vehicle_visit'));
    expect(exited.metadata).toEqual({
      gateId: s.guard.gateId,
      shiftId: s.guard.shiftId,
    });
    const left = await g.serviceIn(s.guard, PLATE);
    await g.backdateService(left.id, 13 * 60);
    await g.sweepServiceExits();
    const closed = await single('service_vehicle.exit_unconfirmed', left.id);
    expect(closed).toMatchObject({
      actorType: 'system',
      actorId: null,
      targetType: 'service_vehicle_visit',
    });
    expect(closed.metadata).toEqual({ gateId: s.guard.gateId });
  });

  it('gate.log_searched: the days, the unit, whether by name and what it found; never the name', async () => {
    await g
      .http('post', '/staff/gate/log-search', s.manager.token, {
        from: today(),
        to: today(),
        visitorName: NAME,
      })
      .expect(200);
    const row = await single('gate.log_searched', s.c.tenantId);
    expect(row).toMatchObject(by(s.manager, 'tenant'));
    expect(row.metadata).toEqual({
      from: today(),
      to: today(),
      unitId: null,
      byName: true,
      results: 0,
      truncated: false,
    });
  });

  describe('catalog completeness', () => {
    it('every entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      const elsewhere = Object.entries(split)
        .filter(([name]) => name !== 'GATE_COMPLETION_COVERAGE')
        .flatMap(([, list]) => list);
      for (const key of split.GATE_COMPLETION_COVERAGE) {
        expect(all).toContain(key);
        expect(elsewhere).not.toContain(key);
      }
      expect([...covered].sort()).toEqual(
        [...split.GATE_COMPLETION_COVERAGE].sort(),
      );
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter(
            (k) =>
              /^(gate_exception|service_vehicle)\./.test(k) ||
              k === 'gate_settings.changed' ||
              k === 'gate.log_searched',
          )
          .sort(),
      ).toEqual([...split.GATE_COMPLETION_COVERAGE].sort());
    });
  });
});
