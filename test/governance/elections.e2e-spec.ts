import {
  CONTEST_CLOSE_SWEEP,
  CONTEST_OPEN_SWEEP,
} from '../../src/governance/contests/contest-sweeps';
import { NOMINATIONS_SWEEP } from '../../src/governance/elections/elections.service';
import {
  governanceHelpers,
  shiftElection,
  type ElectionBody,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

/**
 * ADR 0051: elections of the board — nominations (owners stand and
 * withdraw, the manager disqualifies until voting opens), a secret vote of
 * up to `seats` candidates per unit, and the count at the close: the first
 * `seats` with a vote elected, a tie across the last seat left to the board.
 */
describe('Governance — elections', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  let tenant: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(6);
    await g.appoint(s.manager, s.owners.slice(0, 3));
    const rented = await g.unit(s.c, 'B');
    await g.landlord(s.c, rented.id);
    tenant = await g.tenant(s.c, rented.id);
  }, 180_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: { field: string; code: string }[] }).fields.map(
      (f) => [f.field, f.code],
    );
  const toVoting = async (e: ElectionBody) => {
    await shiftElection(e.id, -25);
    await g.sweep(CONTEST_OPEN_SWEEP);
  };
  const toClose = async (e: ElectionBody) => {
    await shiftElection(e.id, -25);
    await g.sweep(CONTEST_CLOSE_SWEEP);
  };

  describe('calling one', () => {
    it('the board or the manager; seats and dates in range; owners told nominations opened', async () => {
      const e = await g.election(o(0));
      expect(e).toMatchObject({
        phase: 'nominating',
        seats: 3,
        candidates: [],
      });
      expect(e.reference).toMatch(/^GE-\d{4}$/);
      for (const who of s.owners)
        expect(
          (
            await g.notifications(
              s.c,
              who.id,
              'governance_election.nominations_opened',
            )
          ).filter((n) => n.targetId === e.id),
        ).toHaveLength(1);
      expect(
        await g.notifications(
          s.c,
          tenant.id,
          'governance_election.nominations_opened',
        ),
      ).toEqual([]);
      const post = (body: object) =>
        g.http('post', '/governance/elections', s.manager.token, {
          titleEn: 'x',
          bodyEn: 'y',
          seats: 3,
          termMonths: 24,
          nominationsCloseAt: at(25),
          votingOpensAt: at(25),
          votingClosesAt: at(49),
          ...body,
        });
      expect(fields(await post({ seats: 2 }).expect(400))).toEqual([
        ['seats', 'INVALID_NUMBER'],
      ]);
      expect(
        fields(await post({ nominationsCloseAt: at(12) }).expect(400)),
      ).toEqual([['nominationsCloseAt', 'INVALID_VALUE']]);
      expect(fields(await post({ votingOpensAt: at(20) }).expect(400))).toEqual(
        [['votingOpensAt', 'INVALID_VALUE']],
      );
      expect(
        code(
          await g
            .http('post', '/governance/elections', o(4).token, {})
            .expect(403),
        ),
      ).toBe('FORBIDDEN');
    });

    it('changes until nominations open; told once when they do', async () => {
      const e = await g.election(s.manager, {
        nominationsOpenAt: at(2),
        nominationsCloseAt: at(30),
        votingOpensAt: at(30),
        votingClosesAt: at(54),
      });
      expect(e.phase).toBe('upcoming');
      await g
        .http('patch', `/governance/elections/${e.id}`, s.manager.token, {
          termMonths: 36,
        })
        .expect(200);
      const later = new Date(Date.now() + 3 * HOUR);
      await g.sweep(NOMINATIONS_SWEEP, later);
      await g.sweep(NOMINATIONS_SWEEP, later);
      expect(
        (
          await g.notifications(
            s.c,
            o(5).id,
            'governance_election.nominations_opened',
          )
        ).filter((n) => n.targetId === e.id),
      ).toHaveLength(1);
      await shiftElection(e.id, -3);
      const edit = await g
        .http('patch', `/governance/elections/${e.id}`, s.manager.token, {
          termMonths: 12,
        })
        .expect(409);
      expect(code(edit)).toBe('GOVERNANCE_CONTEST_STARTED');
      await g
        .http('post', `/governance/elections/${e.id}/cancel`, s.manager.token, {
          reasonCode: 'created_in_error',
        })
        .expect(200);
    });
  });

  describe('nominations', () => {
    let e: ElectionBody;

    beforeAll(async () => {
      e = await g.election(s.manager);
    });

    it('an owner stands once with a statement, and may withdraw and stand again; a tenant may not', async () => {
      const first = await g
        .stand(o(3), e.id, 'I will fix the lifts.')
        .expect(201);
      expect((first.body as ElectionBody).myCandidacy).toMatchObject({
        status: 'nominated',
        statement: 'I will fix the lifts.',
      });
      expect(code(await g.stand(o(3), e.id).expect(409))).toBe(
        'GOVERNANCE_ALREADY_CANDIDATE',
      );
      await g
        .http(
          'post',
          `/governance/elections/${e.id}/candidacy/withdraw`,
          o(3).token,
        )
        .expect(200);
      expect((await g.electionAs(o(4), e.id)).candidates).toEqual([]);
      await g.stand(o(3), e.id).expect(201);
      expect(code(await g.stand(tenant, e.id).expect(403))).toBe(
        'GOVERNANCE_CANDIDACY_NOT_ALLOWED',
      );
      const long = await g.stand(o(4), e.id, 'x'.repeat(501)).expect(400);
      expect(fields(long)).toEqual([['statement', 'INVALID_LENGTH']]);
    });

    it('the manager disqualifies with a reason, until voting opens', async () => {
      await g.stand(o(4), e.id, 'Vote for me').expect(201);
      const staff = await g
        .http('get', `/staff/governance/elections/${e.id}`, s.manager.token)
        .expect(200);
      const cand = (
        staff.body as {
          candidates: { id: string; accountId: string; status: string }[];
        }
      ).candidates.find(
        (c) => c.accountId === o(4).id && c.status === 'nominated',
      )!;
      const dq = (reasonCode?: string) =>
        g.http(
          'post',
          `/staff/governance/elections/${e.id}/candidates/${cand.id}/disqualify`,
          s.manager.token,
          { ...(reasonCode ? { reasonCode } : {}) },
        );
      expect(code(await dq().expect(400))).toBe('VALIDATION_FAILED');
      await dq('statement_breaks_rules').expect(200);
      expect((await g.electionAs(o(4), e.id)).myCandidacy).toMatchObject({
        status: 'disqualified',
      });
      expect(code(await dq('other').expect(404))).toBe(
        'GOVERNANCE_CANDIDATE_NOT_FOUND',
      );
    });

    it('voting opens with the list fixed; nobody stands or withdraws from then on', async () => {
      await g.stand(o(5), e.id).expect(201);
      await toVoting(e);
      const voting = await g.electionAs(o(0), e.id);
      expect(voting.phase).toBe('voting');
      expect(voting.electorate).toBe(7);
      expect(voting.candidates).toHaveLength(2);
      expect(code(await g.stand(o(0), e.id).expect(409))).toBe(
        'GOVERNANCE_NOMINATIONS_CLOSED',
      );
      expect(
        code(
          await g
            .http(
              'post',
              `/governance/elections/${e.id}/candidacy/withdraw`,
              o(5).token,
            )
            .expect(409),
        ),
      ).toBe('GOVERNANCE_NOMINATIONS_CLOSED');
    });

    it('with nobody standing when voting opens, it is cancelled and the board told', async () => {
      const empty = await g.election(o(1));
      await toVoting(empty);
      const after = await g.electionAs(o(1), empty.id);
      expect(after).toMatchObject({
        phase: 'cancelled',
        cancelReasonCode: 'no_candidates',
      });
      const told = (
        await g.notifications(s.c, o(0).id, 'governance_election.cancelled')
      ).filter((n) => n.targetId === empty.id);
      expect(told[0].params).toEqual({ reason: 'no_candidates' });
    });
  });

  describe('voting and the count', () => {
    let e: ElectionBody;
    let ids: string[];

    beforeAll(async () => {
      e = await g.election(s.manager);
      for (const i of [1, 2, 3, 4]) await g.stand(o(i), e.id).expect(201);
      await toVoting(e);
      ids = (await g.electionAs(o(0), e.id)).candidates.map((c) => c.id);
    });

    it('up to `seats` candidates of the list, each once; once per unit', async () => {
      const four = await g
        .electionVote(o(0), e.id, o(0).unitId, ids)
        .expect(400);
      expect(fields(four)).toEqual([['candidateIds', 'INVALID_LENGTH']]);
      const twice = await g
        .electionVote(o(0), e.id, o(0).unitId, [ids[0], ids[0]])
        .expect(400);
      expect(fields(twice)).toEqual([['candidateIds', 'INVALID_LENGTH']]);
      const stranger = '0192f1c2-7a4b-4c3d-8e9f-0a1b2c3d4e5f';
      expect(
        fields(
          await g.electionVote(o(0), e.id, o(0).unitId, [stranger]).expect(400),
        ),
      ).toEqual([['candidateIds', 'INVALID_VALUE']]);
      const res = await g
        .electionVote(o(0), e.id, o(0).unitId, [ids[0], ids[1]])
        .expect(201);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'electionId',
        'unitId',
        'votedAt',
      ]);
      expect(
        code(
          await g.electionVote(o(0), e.id, o(0).unitId, [ids[2]]).expect(409),
        ),
      ).toBe('GOVERNANCE_ALREADY_VOTED');
    });

    it('nobody sees a count before the close; at the close a tie across the last seat is left to the board', async () => {
      // c0: 3, c1: 2, c2: 2, c3: 2 — the last two seats among three tied.
      await g
        .electionVote(o(1), e.id, o(1).unitId, [ids[0], ids[2]])
        .expect(201);
      await g
        .electionVote(o(2), e.id, o(2).unitId, [ids[0], ids[3]])
        .expect(201);
      await g
        .electionVote(o(3), e.id, o(3).unitId, [ids[2], ids[3]])
        .expect(201);
      await g.electionVote(o(4), e.id, o(4).unitId, [ids[1]]).expect(201);
      const open = await g.electionAs(o(5), e.id);
      expect(open.candidates.map((c) => c.votes)).toEqual([
        null,
        null,
        null,
        null,
      ]);
      expect(open.turnout).toBe(5);
      await toClose(e);
      const closed = await g.electionAs(o(5), e.id);
      expect(closed.phase).toBe('closed');
      expect(closed.candidates.map((c) => [c.votes, c.outcome])).toEqual([
        [3, 'elected'],
        [2, 'tied'],
        [2, 'tied'],
        [2, 'tied'],
      ]);
      expect([...closed.tiedCandidateIds].sort()).toEqual(
        [ids[1], ids[2], ids[3]].sort(),
      );
      const told = (
        await g.notifications(
          s.c,
          s.manager.id,
          'governance_election.awaiting_certification',
        )
      ).filter((n) => n.targetId === e.id);
      expect(told[0].params).toEqual({ tied: 'yes' });
    });
  });
});
