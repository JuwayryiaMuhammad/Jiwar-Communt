import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M210_COVERAGE } from '../setup/audit-coverage-split';
import { experienceHelpers, type ExperienceSetUp } from '../setup/experience';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-m210-secret';

/**
 * One scenario per entry of experience and recovery's catalog (ADR 0014,
 * 0082): actor, target and metadata — codes, ids and amounts, never a
 * case's, a compensation's or a promise's words.
 */
const covered = new Set<string>();

describe('Audit coverage — experience and recovery', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof experienceHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: ExperienceSetUp;
  const o = (i: number) => s.owners[i - 1];

  beforeAll(async () => {
    h = await createHttpHarness();
    e = experienceHelpers(h);
    read = auditReaders(h);
    s = await e.setUp(3, 3);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    covered.add(action);
    return rows[0];
  }

  const manager = () => s.manager.token;

  it('experience.settings_changed — per rule, from and to', async () => {
    await e
      .api('patch', '/settings', manager(), {
        items: [{ code: 'repeated_complaints', count: 4 }],
      })
      .expect(200);
    const row = await single('experience.settings_changed', s.c.tenantId);
    expect(row.actorId).toBe(s.c.managerId);
    expect(row.changes).toEqual({
      'repeated_complaints.count': { from: 3, to: 4 },
    });
  });

  it('experience.compensation_rules_changed — per failure code', async () => {
    await e
      .api('put', '/compensation-rules', manager(), {
        items: [{ failureCode: 'other', kind: 'credit', amount: '20.00' }],
      })
      .expect(200);
    expect(
      (await single('experience.compensation_rules_changed', s.c.tenantId))
        .changes,
    ).toEqual({
      'other.kind': { from: null, to: 'credit' },
      'other.amount': { from: null, to: '20.00' },
    });
  });

  it('experience_signal.raised and experience_case.opened by the system — the unit, the rule, the case', async () => {
    await e.lowRatings(s.c, o(1), 2);
    await e.signals();
    const [signal] = await e.signalsOf(s.c, o(1).unitId);
    const raised = await single('experience_signal.raised', signal.id);
    expect(raised.actorType).toBe('system');
    expect(raised.metadata).toEqual({
      unitId: o(1).unitId,
      code: 'repeated_low_ratings',
      count: 2,
      windowDays: 90,
      caseId: signal.caseId,
    });
    const opened = await single('experience_case.opened', signal.caseId!);
    expect(opened.actorType).toBe('system');
    expect(opened.metadata).toMatchObject({
      unitId: o(1).unitId,
      kind: 'follow_up',
      origin: 'signal',
      signalId: signal.id,
      signal: 'repeated_low_ratings',
    });
  });

  it('experience_case.opened by hand, assigned and closed — codes and ids, never the notes', async () => {
    const opened = await e.openCase(manager(), {
      unitId: o(2).unitId,
      kind: 'recovery',
      failureCode: 'service_outage',
      note: `${MARKER} no water for two days`,
    });
    expect(
      (await single('experience_case.opened', opened.id)).metadata,
    ).toEqual({
      unitId: o(2).unitId,
      number: opened.number,
      kind: 'recovery',
      origin: 'manual',
      failureCode: 'service_outage',
    });
    const staff = await e.staff(s.c, ['experience.manage']);
    await e
      .api('post', `/cases/${opened.id}/assign`, manager(), {
        ownerId: staff.id,
      })
      .expect(201);
    expect(
      (await single('experience_case.assigned', opened.id)).metadata,
    ).toEqual({ ownerId: staff.id, previousOwnerId: null });
    // Proposed, approved, rejected.
    const apology = await e.propose(staff.token, opened.id, {
      kind: 'apology',
      failureCode: 'service_outage',
      note: `${MARKER} call them`,
    });
    expect(
      (await single('experience_compensation.proposed', apology.id)).metadata,
    ).toEqual({
      caseId: opened.id,
      unitId: o(2).unitId,
      kind: 'apology',
      failureCode: 'service_outage',
    });
    await e.decide(manager(), apology.id, { decision: 'approve' }).expect(201);
    expect(
      (await single('experience_compensation.approved', apology.id)).metadata,
    ).toEqual({ caseId: opened.id, kind: 'apology' });
    const credit = await e.propose(staff.token, opened.id, {
      kind: 'credit',
      amount: '40.00',
    });
    await e
      .decide(manager(), credit.id, {
        decision: 'reject',
        reasonCode: 'already_compensated',
      })
      .expect(201);
    expect(
      (await single('experience_compensation.rejected', credit.id)).metadata,
    ).toEqual({ caseId: opened.id, reasonCode: 'already_compensated' });
    await e
      .api('post', `/cases/${opened.id}/close`, manager(), {
        outcome: 'compensated',
        note: `${MARKER} they accepted`,
      })
      .expect(201);
    expect(
      (await single('experience_case.closed', opened.id)).metadata,
    ).toEqual({ outcome: 'compensated' });
  });

  it('service_promise.created and .updated — the terms, never the titles', async () => {
    const res = await e
      .api('post', '/promises', manager(), {
        titleEn: `${MARKER} repairs within two days`,
        titleAr: 'إصلاح خلال يومين',
        metric: 'ticket_resolution_hours',
        target: 48,
        targetShare: 90,
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    expect((await single('service_promise.created', id)).metadata).toEqual({
      metric: 'ticket_resolution_hours',
      target: '48.00',
      targetShare: 90,
    });
    await e
      .api('patch', `/promises/${id}`, manager(), { active: false })
      .expect(200);
    expect((await single('service_promise.updated', id)).metadata).toEqual({
      metric: 'ticket_resolution_hours',
      target: '48.00',
      targetShare: 90,
      active: false,
      titles: false,
    });
  });

  describe('catalog completeness', () => {
    it('every entry of experience and recovery has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M210_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M210_COVERAGE].sort());
    });
  });
});
