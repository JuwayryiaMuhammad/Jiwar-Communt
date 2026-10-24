import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { DECISION_APPEALS_COVERAGE } from '../setup/audit-coverage-split';
import {
  decisionAppealHelpers,
  type DecisionAppealsSetUp,
} from '../setup/decision-appeals';
import { eraseNow } from '../setup/erasure';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';

/**
 * One scenario per decision appeal entry (ADR 0014, 0059): actor, target,
 * changes and metadata — ids, codes and times; the grounds and the
 * rationale as changed, never their words.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — decision appeals', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof decisionAppealHelpers>;
  let s: DecisionAppealsSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = decisionAppealHelpers(h);
    s = await d.setUp('Appeals Audit Court');
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    expect(leakText(found[0])).not.toContain(MARKER);
    return found[0];
  }

  it('lodged and decided: codes and times, the words as changed', async () => {
    const permitId = await d.rejectedPermit(s.manager, s.alice, s.home.id);
    const lodged = await d.lodge(s.alice, 'permit_rejection', permitId, {
      grounds: `${MARKER} the hours fit`,
    });
    const row = await single('decision_appeal.lodged', lodged.id);
    expect(row).toMatchObject({
      actorType: 'account',
      actorId: s.alice.id,
      targetType: 'decision_appeal',
    });
    expect(row.changes).toMatchObject({
      kind: { to: 'permit_rejection' },
      subjectId: { to: permitId },
      unitId: { to: s.home.id },
      attachments: { to: 0 },
      grounds: { changed: true },
    });
    await d.decide(s.decider, lodged.id, {
      outcome: 'upheld',
      rationale: `${MARKER} the rules stand`,
    });
    const decided = await single('decision_appeal.decided', lodged.id);
    expect(decided).toMatchObject({
      actorId: s.decider.id,
      targetType: 'decision_appeal',
    });
    expect(decided.metadata).toEqual({
      outcome: 'upheld',
      effect: 'none',
      effectReason: null,
      deciderRoleKey: 'manager',
    });
    expect(decided.changes).toMatchObject({ rationale: { changed: true } });
  });

  it('withdrawn', async () => {
    const vehicleId = await d.rejectedVehicle(s.manager, s.alice, s.home.id);
    const lodged = await d.lodge(s.alice, 'vehicle_rejection', vehicleId);
    await d.withdrawRaw(s.alice, lodged.id).expect(200);
    const row = await single('decision_appeal.withdrawn', lodged.id);
    expect(row).toMatchObject({
      actorId: s.alice.id,
      targetType: 'decision_appeal',
    });
  });

  it('an overturn left to follow up, followed up', async () => {
    const engagementId = await d.rejectedWorker(s.c, s.alice, s.home.id);
    const lodged = await d.lodge(s.alice, 'worker_rejection', engagementId);
    await d.decide(s.decider, lodged.id, { outcome: 'overturned' });
    await d
      .http(
        'post',
        `/staff/decision-appeals/${lodged.id}/followed-up`,
        s.decider.token,
      )
      .expect(200);
    const row = await single('decision_appeal.followed_up', lodged.id);
    expect(row).toMatchObject({ actorId: s.decider.id });
  });

  it('the appellant’s erasure clears the grounds, once', async () => {
    const other = await d.setUp('Appeals Erasure Court');
    // A co-owner of the home, its car's keeper: not its primary, so their
    // account may go.
    const keeper = await d.v.owner(other.c, other.home.id);
    const vehicleId = await d.rejectedVehicle(
      other.manager,
      keeper,
      other.home.id,
    );
    const lodged = await d.lodge(keeper, 'vehicle_rejection', vehicleId, {
      grounds: `${MARKER} erased`,
    });
    await eraseNow(h, other.c, keeper.id);
    const found = await read.tenant(other.c.tenantId, {
      action: 'decision_appeal.grounds_cleared',
      targetId: lodged.id,
    });
    covered.add('decision_appeal.grounds_cleared');
    expect(found).toHaveLength(1);
    expect(found[0].metadata).toEqual({ attachments: 0 });
    const row = await d.row(other.c, lodged.id);
    expect(row.grounds).toBeNull();
    expect(row.groundsClearedAt).not.toBeNull();
  });

  describe('catalog completeness', () => {
    it('every decision appeal entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of DECISION_APPEALS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual(
        [...DECISION_APPEALS_COVERAGE].sort(),
      );
      expect(all.filter((k) => /^decision_appeal\./.test(k)).sort()).toEqual(
        [...DECISION_APPEALS_COVERAGE].sort(),
      );
    });
  });
});
