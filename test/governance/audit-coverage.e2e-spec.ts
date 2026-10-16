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
  PERMITS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
  SAFETY_COVERAGE,
  VEHICLES_COVERAGE,
} from '../setup/audit-coverage-split';
import {
  CONTEST_CLOSE_SWEEP,
  CONTEST_OPEN_SWEEP,
} from '../../src/governance/contests/contest-sweeps';
import {
  governanceHelpers,
  lapse,
  shiftContest,
  shiftElection,
  type StaffTermBody,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per governance catalog entry (ADR 0014, 0051): actor,
 * target, changes and metadata — ids, roles, codes, dates and counts by
 * value; never a name, a statement or what anyone chose.
 */
const covered = new Set<string>();

describe('Audit coverage — governance', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(5);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });
  const o = (i: number) => s.owners[i];

  describe('the board', () => {
    let first: StaffTermBody;

    it('appointed: seats, dates and the members by id and role; each seat added', async () => {
      first = await g.appoint(s.manager, [o(0), o(1), o(2)], { seats: 4 });
      const a = await single('board_term.appointed', first.id);
      expect(a).toMatchObject(by(s.manager, 'board_term'));
      expect(a.metadata).toEqual({
        seats: 4,
        startsAt: first.startsAt,
        endsAt: first.endsAt,
        members: [
          { accountId: o(0).id, role: 'chair' },
          { accountId: o(1).id, role: 'member' },
          { accountId: o(2).id, role: 'member' },
        ],
        lapsedTermId: null,
      });
      const seat = first.members[1];
      const added = await single('board_member.added', seat.id);
      expect(added).toMatchObject(by(s.manager, 'board_member'));
      expect(added.metadata).toEqual({
        termId: first.id,
        accountId: o(1).id,
        role: 'member',
        source: 'appointed',
      });
    });

    it('role_changed: from and to', async () => {
      const seat = first.members[1];
      await g
        .http(
          'patch',
          `/staff/governance/board/members/${seat.id}`,
          s.manager.token,
          {
            role: 'treasurer',
          },
        )
        .expect(200);
      const c = await single('board_member.role_changed', seat.id);
      expect(c).toMatchObject(by(s.manager, 'board_member'));
      expect(c.metadata).toEqual({
        termId: first.id,
        accountId: o(1).id,
        from: 'member',
        to: 'treasurer',
      });
    });

    it('ended: the reason’s code and the side', async () => {
      const seat = first.members[2];
      await g
        .http(
          'post',
          `/staff/governance/board/members/${seat.id}/end`,
          s.manager.token,
          {
            reasonCode: 'resigned',
          },
        )
        .expect(200);
      const e = await single('board_member.ended', seat.id);
      expect(e).toMatchObject(by(s.manager, 'board_member'));
      expect(e.metadata).toEqual({
        termId: first.id,
        accountId: o(2).id,
        reasonCode: 'resigned',
        side: 'manager',
      });
    });

    it('term ended: replaced by the next appointment after a lapse', async () => {
      await lapse(first.id);
      const next = await g.appoint(s.manager, [o(2), o(3), o(4)]);
      const ended = await single('board_term.ended', first.id);
      expect(ended).toMatchObject(by(s.manager, 'board_term'));
      expect(ended.metadata).toEqual({ reason: 'replaced', byTermId: next.id });
      const appointed = (
        await read.tenant(s.c.tenantId, {
          action: 'board_term.appointed',
          targetId: next.id,
        })
      )[0];
      expect(appointed.metadata).toMatchObject({ lapsedTermId: first.id });
    });
  });

  describe('polls and votes', () => {
    it('created and changed: settings by value, texts as "changed"; opened: the electorate', async () => {
      const p = await g.poll(s.manager, {
        opensAt: new Date(Date.now() + 3_600_000).toISOString(),
        closesAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      });
      const created = await single('governance_poll.created', p.id);
      expect(created).toMatchObject(by(s.manager, 'governance_poll'));
      expect(created.metadata).toEqual({ side: 'manager' });
      expect(created.changes).toMatchObject({
        kind: { from: null, to: 'yes_no' },
        ballot: { from: null, to: 'secret' },
        quorumPct: { from: null, to: 50 },
        thresholdPct: { from: null, to: 50 },
        options: { from: null, to: 3 },
        titleEn: { changed: true },
        bodyEn: { changed: true },
      });
      expect(JSON.stringify(created)).not.toContain('Repaint');
      await g
        .http('patch', `/governance/polls/${p.id}`, s.manager.token, {
          quorumPct: 40,
          titleEn: 'Repaint the gate',
        })
        .expect(200);
      const changed = await single('governance_poll.changed', p.id);
      expect(changed.changes).toEqual({
        quorumPct: { from: 50, to: 40 },
        titleEn: { changed: true },
      });
      await g.sweep(CONTEST_OPEN_SWEEP, new Date(Date.now() + 2 * 3_600_000));
      const opened = await single('governance_poll.opened', p.id);
      expect(opened).toMatchObject({
        actorType: 'system',
        targetType: 'governance_poll',
      });
      expect(opened.metadata).toEqual({ electorate: 5, ballot: 'secret' });
    });

    it('vote_cast: the unit, never the choice; closed: result and turnout; cancelled: the reason', async () => {
      const p = await g.poll(s.manager, { quorumPct: 20 });
      const contestId = await g.contestOf(s.c, p.id);
      await g
        .castVote(o(0), p.id, o(0).unitId, [g.option(p, 'no')])
        .expect(201);
      const vote = await single('governance.vote_cast', contestId);
      expect(vote).toMatchObject(by(o(0), 'governance_contest'));
      expect(vote.metadata).toEqual({ kind: 'poll', unitId: o(0).unitId });
      expect(JSON.stringify(vote)).not.toContain(g.option(p, 'no'));
      await shiftContest(contestId, -80);
      await g.sweep(CONTEST_CLOSE_SWEEP);
      const closed = await single('governance_poll.closed', p.id);
      expect(closed).toMatchObject({ actorType: 'system' });
      expect(closed.metadata).toEqual({
        result: 'failed',
        turnout: 1,
        electorate: 5,
      });
      const q = await g.poll(o(2));
      await g
        .http('post', `/governance/polls/${q.id}/cancel`, o(2).token, {
          reasonCode: 'board_decision',
        })
        .expect(200);
      const cancelled = await single('governance_poll.cancelled', q.id);
      expect(cancelled).toMatchObject(by(o(2), 'governance_poll'));
      expect(cancelled.metadata).toEqual({
        fromStatus: 'open',
        reasonCode: 'board_decision',
        side: 'board',
      });
    });
  });

  describe('elections and candidates', () => {
    const at = (hours: number) =>
      new Date(Date.now() + hours * 3_600_000).toISOString();

    it('created and changed: seats, term and dates by value, texts as "changed"', async () => {
      const e = await g.election(s.manager, {
        nominationsOpenAt: at(2),
        nominationsCloseAt: at(30),
        votingOpensAt: at(30),
        votingClosesAt: at(54),
      });
      const created = await single('governance_election.created', e.id);
      expect(created).toMatchObject(by(s.manager, 'governance_election'));
      expect(created.metadata).toEqual({ side: 'manager' });
      expect(created.changes).toMatchObject({
        seats: { from: null, to: 3 },
        termMonths: { from: null, to: 24 },
        titleEn: { changed: true },
      });
      expect(JSON.stringify(created)).not.toContain('The board, 2027');
      await g
        .http('patch', `/governance/elections/${e.id}`, s.manager.token, {
          termMonths: 36,
        })
        .expect(200);
      const changed = await single('governance_election.changed', e.id);
      expect(changed.changes).toEqual({ termMonths: { from: 24, to: 36 } });
      await g
        .http('post', `/governance/elections/${e.id}/cancel`, s.manager.token, {
          reasonCode: 'postponed',
        })
        .expect(200);
      const cancelled = await single('governance_election.cancelled', e.id);
      expect(cancelled.metadata).toEqual({
        fromPhase: 'upcoming',
        reasonCode: 'postponed',
        side: 'manager',
      });
    });

    it('nominated, withdrawn, disqualified: ids and codes, never the statement', async () => {
      const e = await g.election(s.manager);
      const stood = await g.stand(o(0), e.id, 'Words of mine').expect(201);
      const mine = (stood.body as { myCandidacy: { id: string } }).myCandidacy
        .id;
      const nominated = await single('governance_candidate.nominated', mine);
      expect(nominated).toMatchObject(by(o(0), 'governance_candidate'));
      expect(nominated.metadata).toEqual({ electionId: e.id, statement: true });
      expect(JSON.stringify(nominated)).not.toContain('Words of mine');
      await g
        .http(
          'post',
          `/governance/elections/${e.id}/candidacy/withdraw`,
          o(0).token,
        )
        .expect(200);
      const withdrawn = await single('governance_candidate.withdrawn', mine);
      expect(withdrawn.metadata).toEqual({
        electionId: e.id,
        side: 'candidate',
        reasonCode: null,
      });
      const other = await g.stand(o(1), e.id).expect(201);
      const theirs = (other.body as { myCandidacy: { id: string } }).myCandidacy
        .id;
      await g
        .http(
          'post',
          `/staff/governance/elections/${e.id}/candidates/${theirs}/disqualify`,
          s.manager.token,
          { reasonCode: 'not_eligible' },
        )
        .expect(200);
      const dq = await single('governance_candidate.disqualified', theirs);
      expect(dq).toMatchObject(by(s.manager, 'governance_candidate'));
      expect(dq.metadata).toEqual({
        electionId: e.id,
        reasonCode: 'not_eligible',
      });
    });

    it('opened: electorate and candidates; closed: the counts of seats, never of a candidate', async () => {
      const e = await g.election(s.manager);
      await g.stand(o(3), e.id).expect(201);
      await shiftElection(e.id, -25);
      await g.sweep(CONTEST_OPEN_SWEEP);
      const opened = await single('governance_election.opened', e.id);
      expect(opened).toMatchObject({ actorType: 'system' });
      expect(opened.metadata).toEqual({ electorate: 5, candidates: 1 });
      const [candidate] = (await g.electionAs(o(3), e.id)).candidates;
      await g.electionVote(o(3), e.id, o(3).unitId, [candidate.id]).expect(201);
      await shiftElection(e.id, -25);
      await g.sweep(CONTEST_CLOSE_SWEEP);
      const closed = await single('governance_election.closed', e.id);
      expect(closed.metadata).toEqual({
        turnout: 1,
        electorate: 5,
        elected: 1,
        tied: 0,
        remaining: 0,
      });
    });

    it('certified: the term and the ids seated, never a name', async () => {
      const e = (
        await g
          .http(
            'get',
            '/staff/governance/elections?phase=closed',
            s.manager.token,
          )
          .expect(200)
      ).body as { data: { id: string; candidates: { id: string }[] }[] };
      const closed = e.data[0];
      const res = await g
        .http(
          'post',
          `/staff/governance/elections/${closed.id}/certify`,
          s.manager.token,
          {},
        )
        .expect(200);
      const termId = (res.body as { termId: string }).termId;
      const certified = await single(
        'governance_election.certified',
        closed.id,
      );
      expect(certified).toMatchObject(by(s.manager, 'governance_election'));
      expect(certified.metadata).toEqual({
        termId,
        elected: [closed.candidates[0].id],
        ineligible: [],
        tied: 0,
        tieBreak: [],
        tieReasonCode: null,
      });
    });
  });

  describe('catalog completeness', () => {
    it('every governance entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of GOVERNANCE_COVERAGE) {
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
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...GOVERNANCE_COVERAGE].sort());
      // And nothing of the domain is left out of the list.
      expect(
        all
          .filter((k) =>
            /^(board_term|board_member|governance_poll|governance_election|governance_candidate|board_publication)\.|^governance\./.test(
              k,
            ),
          )
          .sort(),
      ).toEqual([...GOVERNANCE_COVERAGE].sort());
    });
  });
});
