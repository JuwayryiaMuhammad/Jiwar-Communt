import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import * as split from '../setup/audit-coverage-split';
import { BOARD_MATTERS_COVERAGE } from '../setup/audit-coverage-split';
import { boardMatterHelpers } from '../setup/board-matters';
import { lapse } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per board-matters catalog entry (ADR 0014, 0055): actor,
 * target, and ids, codes, amounts and counts by value; a package's words
 * and a motion's reasons as "changed"; never a vote's choice.
 */
const covered = new Set<string>();

describe('Audit coverage — board matters (ADR 0055)', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    s = await b.setUp(4, 3);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const o = (i: number) => s.owners[i];

  it('raised: the package by value, its words as changed', async () => {
    const r = await b.raise(s.accountant, {
      context: 'AUDIT-CONTEXT words',
      impact: 'AUDIT-IMPACT words',
      alternatives: [{ text: 'AUDIT-ALT words' }],
    });
    const a = await single('governance_approval.raised', r.id);
    expect(a).toMatchObject({
      actorId: s.accountant.id,
      targetType: 'governance_approval',
      changes: {
        type: { from: null, to: 'exceptional_fee' },
        cost: { from: null, to: '1200.00' },
        alternatives: { from: null, to: 1 },
        attachments: { from: null, to: 0 },
        context: { changed: true },
        impact: { changed: true },
      },
    });
    expect(JSON.stringify(a)).not.toContain('AUDIT-');
  });

  it('proposed, cast, closed and decided: ids and counts; the reasons as changed, never a choice', async () => {
    const r = await b.raise(s.accountant);
    const m = await b.motion(o(0), r.id, { rationale: 'AUDIT-RATIONALE' });
    const proposed = await single('board_motion.proposed', m.id);
    expect(proposed).toMatchObject({
      actorId: o(0).id,
      targetType: 'board_motion',
      changes: {
        matter: { from: null, to: 'approval' },
        matterId: { from: null, to: r.id },
        outcome: { from: null, to: 'approve' },
        rationale: { changed: true },
      },
    });
    expect(JSON.stringify(proposed)).not.toContain('AUDIT-');
    await b.vote(o(0), m.id, 'for').expect(201);
    await b.vote(o(1), m.id, 'for').expect(201);
    const votes = await read.tenant(s.c.tenantId, {
      action: 'board_vote.cast',
      targetId: m.id,
    });
    covered.add('board_vote.cast');
    expect(votes).toHaveLength(2);
    for (const v of votes) {
      expect(JSON.stringify(v)).not.toMatch(/"for"|"against"|choice/);
      expect(v.metadata).toEqual({
        memberId: expect.any(String) as string,
        voteId: expect.any(String) as string,
      });
    }
    const closed = await single('board_motion.closed', m.id);
    expect(closed.metadata).toEqual({
      result: 'carried',
      votesFor: 2,
      votesAgainst: 0,
      sitting: 3,
      quorum: 2,
      chair: expect.any(String) as string,
      by: 'vote',
    });
    const decided = await single('governance_approval.decided', r.id);
    expect(decided.metadata).toEqual({
      decision: 'approved',
      motionId: m.id,
      implemented: false,
      announcementId: null,
    });
    await b
      .http(
        'post',
        `/staff/governance/approvals/${r.id}/implemented`,
        s.manager.token,
        {
          note: 'AUDIT-NOTE',
        },
      )
      .expect(200);
    const done = await single('governance_approval.implemented', r.id);
    expect(done.metadata).toEqual({ note: true });
  });

  it('withdrawn: the code, the side, the motion it closed', async () => {
    const r = await b.raise(s.accountant);
    const m = await b.motion(o(1), r.id);
    await b
      .http(
        'post',
        `/staff/governance/approvals/${r.id}/withdraw`,
        s.manager.token,
        {
          reasonCode: 'raised_in_error',
        },
      )
      .expect(200);
    const a = await single('governance_approval.withdrawn', r.id);
    expect(a.metadata).toEqual({
      reasonCode: 'raised_in_error',
      side: 'manager',
      motionId: m.id,
    });
  });

  it('the settings: what changed, by value', async () => {
    await b
      .http('patch', '/staff/governance/settings', s.manager.token, {
        items: [
          { type: 'major_contract', deadlineDays: 21, threshold: '75000.00' },
        ],
      })
      .expect(200);
    const a = await single('governance_settings.changed', s.c.tenantId);
    expect(a.changes).toEqual({
      'major_contract.deadlineDays': { from: 14, to: 21 },
      'major_contract.threshold': { from: null, to: '75000.00' },
    });
  });

  it('a lapse is the system’s', async () => {
    const r = await b.raise(s.accountant);
    const m = await b.motion(o(2), r.id);
    await lapse(s.term.id);
    await b.sweepMatters();
    const all = await read.tenant(s.c.tenantId, {
      action: 'board_motion.closed',
      targetId: m.id,
    });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      actorType: 'system',
      metadata: { result: 'lapsed', by: 'system', chair: null },
    });
  });

  describe('catalog completeness', () => {
    it('every board-matters entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      const others = Object.entries(split)
        .filter(([name]) => name !== 'BOARD_MATTERS_COVERAGE')
        .flatMap(([, list]) => list);
      for (const key of BOARD_MATTERS_COVERAGE) {
        expect(all).toContain(key);
        expect(others).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...BOARD_MATTERS_COVERAGE].sort());
      expect(
        all
          .filter((k) =>
            /^(governance_approval|governance_settings|board_motion|board_vote)\./.test(
              k,
            ),
          )
          .sort(),
      ).toEqual([...BOARD_MATTERS_COVERAGE].sort());
    });
  });
});
