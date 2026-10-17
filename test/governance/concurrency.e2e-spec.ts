import {
  CONTEST_CLOSE_SWEEP,
  CONTEST_OPEN_SWEEP,
  CONTEST_REMIND_SWEEP,
} from '../../src/governance/contests/contest-sweeps';
import {
  governanceHelpers,
  lapse,
  shiftContest,
  shiftElection,
  superuserSql,
  type PollBody,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 3;
const HOUR = 3_600_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR);

/**
 * ADR 0051, the races: a unit votes once whatever the timing; a vote and
 * the close or cancel of its contest never interleave (every accepted vote
 * is counted, every ballot has its participation); a contest opens and
 * closes once; the list of an election is fixed by its opening; a board is
 * certified once and two boards never sit at once; an office has one
 * holder; a seat ended, or a board succeeded, a moment ago acts no more:
 * a poll its member put exists only if the history shows the seat held
 * when the poll was decided.
 */
describe('Governance — concurrency', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(8);
    await g.appoint(s.manager, s.owners.slice(0, 3), { seats: 6 });
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  /** Every vote row of a contest, as the database holds it. */
  const counts = async (contestId: string) =>
    g.inTx(s.c, async (tx) => {
      const [box] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM governance_ballot_boxes b,
               jsonb_object_keys(b.ballots) k WHERE b.contest_id = ${contestId}::uuid`;
      return {
        participations: await tx.governanceParticipation.count({
          where: { contestId },
        }),
        boxed: box.n,
        boxes: await tx.governanceBallotBox.count({ where: { contestId } }),
        ballots: await tx.governanceBallot.count({ where: { contestId } }),
        contest: await tx.governanceContest.findUniqueOrThrow({
          where: { id: contestId },
        }),
      };
    });
  /**
   * Whether the history the database keeps shows `accountId` seated, on a
   * board sitting, at `at`: the seat added before and not ended before it,
   * its term begun, not lapsed and not ended before it. Ends are dated
   * under the seat's and the term's locks, after any action taken with
   * them, so a poll put with a seat is never dated after the seat's end.
   */
  const satAt = (accountId: string, at: Date) =>
    g.inTx(s.c, async (tx) => {
      const rows = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM board_members m
          JOIN board_terms t ON t.tenant_id = m.tenant_id AND t.id = m.term_id
         WHERE m.account_id = ${accountId}::uuid
           AND m.added_at <= ${at} AND (m.ended_at IS NULL OR ${at} <= m.ended_at)
           AND t.starts_at <= ${at} AND ${at} < t.ends_at
           AND (t.ended_at IS NULL OR ${at} <= t.ended_at)`;
      return rows.length > 0;
    });
  /** A poll a seated member puts, to race something that ends the seat. */
  const putPoll = (member: Who) =>
    g.http('post', '/governance/polls', member.token, {
      kind: 'yes_no',
      titleEn: 'Race',
      bodyEn: 'Race.',
      secret: true,
      quorumPct: 50,
      thresholdPct: 50,
      closesAt: later(48).toISOString(),
    });
  /** The poll a race let through: put while the seat was held, then cancelled. */
  const putWhileSeated = async (member: Who, put: { body: unknown }) => {
    const created = await g.inTx(s.c, (tx) =>
      tx.governancePoll.findUniqueOrThrow({
        where: { id: (put.body as { id: string }).id },
      }),
    );
    expect(created.authorSide).toBe('board');
    expect(await satAt(member.id, created.createdAt)).toBe(true);
    await g
      .http('post', `/governance/polls/${created.id}/cancel`, s.manager.token, {
        reasonCode: 'other',
      })
      .expect(200);
  };
  /** Runs the close sweep until nothing of `contestId` is left open. */
  const closeUntilDone = async (contestId: string) => {
    for (let i = 0; i < 10; i++) {
      await g.sweep(CONTEST_CLOSE_SWEEP, later(200));
      if ((await counts(contestId)).contest.closedAt) return;
    }
    throw new Error('the contest never closed');
  };

  it('R1: a unit voting twice at once is counted once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await g.poll(s.manager);
      const yes = g.option(p, 'yes');
      const res = await Promise.all(
        [0, 1, 2, 3, 4].map(() => g.castVote(o(0), p.id, o(0).unitId, [yes])),
      );
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of res.filter((x) => x.status !== 201))
        expect([r.status, code(r)]).toEqual([409, 'GOVERNANCE_ALREADY_VOTED']);
      const c = await counts(await g.contestOf(s.c, p.id));
      expect([c.participations, c.boxed]).toEqual([1, 1]);
      await g
        .http('post', `/governance/polls/${p.id}/cancel`, s.manager.token, {
          reasonCode: 'other',
        })
        .expect(200);
    }
  });

  it('R2: votes racing the close: every accepted vote is in the count, every other refused, one ballot each', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p: PollBody = await g.poll(s.manager, { quorumPct: 1 });
      const contestId = await g.contestOf(s.c, p.id);
      const yes = g.option(p, 'yes');
      // Its close a moment away: the votes race the clock and the sweep.
      await superuserSql(
        `UPDATE governance_contests SET closes_at = now() + interval '300 milliseconds' WHERE id = $1`,
        [contestId],
      );
      const [, ...votes] = await Promise.all([
        new Promise((r) => setTimeout(r, 250)).then(() =>
          g.sweep(CONTEST_CLOSE_SWEEP, later(200)),
        ),
        ...s.owners.map((v) => g.castVote(v, p.id, v.unitId, [yes])),
      ]);
      await closeUntilDone(contestId);
      const accepted = votes.filter((v) => v.status === 201).length;
      for (const v of votes.filter((x) => x.status !== 201))
        expect([v.status, code(v)]).toEqual([
          409,
          'GOVERNANCE_CONTEST_NOT_OPEN',
        ]);
      const c = await counts(contestId);
      expect(c).toMatchObject({
        participations: accepted,
        boxes: 0,
        ballots: accepted,
      });
      expect(c.contest.turnout).toBe(accepted);
      const closed = await g.pollAs(o(0), p.id);
      expect(closed.options.find((x) => x.key === 'yes')!.votes).toBe(accepted);
    }
  });

  it('R3: votes racing a cancel: nothing is counted, no ballot is left behind', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await g.poll(o(1));
      const contestId = await g.contestOf(s.c, p.id);
      const yes = g.option(p, 'yes');
      const [cancelled, ...votes] = await Promise.all([
        g.http('post', `/governance/polls/${p.id}/cancel`, o(1).token, {
          reasonCode: 'other',
        }),
        ...s.owners.map((v) => g.castVote(v, p.id, v.unitId, [yes])),
      ]);
      expect(cancelled.status).toBe(200);
      for (const v of votes) expect([201, 409]).toContain(v.status);
      const c = await counts(contestId);
      expect(c).toMatchObject({ boxes: 0, ballots: 0, boxed: 0 });
      expect(c.participations).toBe(
        votes.filter((v) => v.status === 201).length,
      );
    }
  });

  it('R4 and R5: two sweeps open a contest once and close it once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await g.poll(s.manager, {
        opensAt: later(1).toISOString(),
        closesAt: later(30).toISOString(),
      });
      const contestId = await g.contestOf(s.c, p.id);
      await Promise.all([
        g.sweep(CONTEST_OPEN_SWEEP, later(2)),
        g.sweep(CONTEST_OPEN_SWEEP, later(2)),
      ]);
      const opened = await counts(contestId);
      expect(opened.contest.electorate).toBe(8);
      expect(
        await g.inTx(s.c, (tx) =>
          tx.governanceElector.count({ where: { contestId } }),
        ),
      ).toBe(8);
      expect(
        (await g.notifications(s.c, o(4).id, 'governance_poll.opened')).filter(
          (n) => n.targetId === p.id,
        ),
      ).toHaveLength(1);
      await g
        .castVote(o(4), p.id, o(4).unitId, [g.option(p, 'no')])
        .expect(201);
      await shiftContest(contestId, -40);
      await Promise.all([
        g.sweep(CONTEST_CLOSE_SWEEP),
        g.sweep(CONTEST_CLOSE_SWEEP),
      ]);
      await closeUntilDone(contestId);
      expect(await counts(contestId)).toMatchObject({
        ballots: 1,
        participations: 1,
      });
      expect(
        await g.inTx(s.c, (tx) =>
          tx.auditLog.count({
            where: { action: 'governance_poll.closed', targetId: p.id },
          }),
        ),
      ).toBe(1);
    }
  });

  it('R6: a candidacy racing the opening of the vote is on the fixed list, or refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const e = await g.election(s.manager);
      await g.stand(o(5), e.id).expect(201);
      // Nominations close and voting opens a moment from now.
      await superuserSql(
        `UPDATE governance_elections SET nominations_close_at = now() + interval '300 milliseconds' WHERE id = $1`,
        [e.id],
      );
      await superuserSql(
        `UPDATE governance_contests c SET opens_at = now() + interval '300 milliseconds'
           FROM governance_elections e WHERE e.id = $1 AND c.id = e.contest_id`,
        [e.id],
      );
      const [, stood] = await Promise.all([
        new Promise((r) => setTimeout(r, 250)).then(() =>
          g.sweep(CONTEST_OPEN_SWEEP, later(1)),
        ),
        new Promise((r) => setTimeout(r, 250)).then(() => g.stand(o(6), e.id)),
      ]);
      await g.sweep(CONTEST_OPEN_SWEEP, later(1));
      const opened = await g.electionAs(o(0), e.id);
      expect(opened.phase).toBe('voting');
      const onList = opened.candidates.length === 2;
      if (stood.status === 201) expect(onList).toBe(true);
      else {
        expect([stood.status, code(stood)]).toEqual([
          409,
          'GOVERNANCE_NOMINATIONS_CLOSED',
        ]);
        expect(onList).toBe(false);
      }
      await g
        .http('post', `/governance/elections/${e.id}/cancel`, s.manager.token, {
          reasonCode: 'other',
        })
        .expect(200);
    }
  });

  it('R7 and R8: an election is certified once; certifying racing an appointment leaves one board', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const e = await g.election(s.manager);
      await g.stand(o(7), e.id).expect(201);
      await shiftElection(e.id, -25);
      await g.sweep(CONTEST_OPEN_SWEEP);
      const [c] = (await g.electionAs(o(7), e.id)).candidates;
      await g.electionVote(o(7), e.id, o(7).unitId, [c.id]).expect(201);
      await shiftElection(e.id, -25);
      await g.sweep(CONTEST_CLOSE_SWEEP);
      // A lapsed board: an appointment may race the certification.
      const board = (await g.staffBoard(s.manager))!;
      await lapse(board.id);
      const certify = () =>
        g.http(
          'post',
          `/staff/governance/elections/${e.id}/certify`,
          s.manager.token,
          {},
        );
      const appoint = g.http(
        'post',
        '/staff/governance/board/appoint',
        s.manager.token,
        {
          seats: 3,
          endsAt: later(24 * 365).toISOString(),
          members: [o(0), o(1), o(2)].map((m) => ({
            accountId: m.id,
            role: 'member',
          })),
        },
      );
      const [one, two, appointed] = await Promise.all([
        certify(),
        certify(),
        appoint,
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect([201, 409]).toContain(appointed.status);
      const open = await g.inTx(s.c, (tx) =>
        tx.boardTerm.findMany({ where: { endedAt: null } }),
      );
      expect(open).toHaveLength(1);
      expect(
        await g.inTx(s.c, (tx) =>
          tx.boardTerm.count({ where: { electionId: e.id } }),
        ),
      ).toBe(1);
    }
  });

  it('R9: the reminder a day before the close goes out once', async () => {
    const p = await g.poll(s.manager, { closesAt: later(48).toISOString() });
    await Promise.all([
      g.sweep(CONTEST_REMIND_SWEEP, later(30)),
      g.sweep(CONTEST_REMIND_SWEEP, later(30)),
      g.sweep(CONTEST_REMIND_SWEEP, later(30)),
    ]);
    for (const who of s.owners)
      expect(
        (
          await g.notifications(s.c, who.id, 'governance_poll.closing_soon')
        ).filter((n) => n.targetId === p.id),
      ).toHaveLength(1);
  });

  it('R10: two members made chair at once: one holds the office', async () => {
    // A board of three again, whatever R7 left.
    await lapse((await g.staffBoard(s.manager))!.id);
    await g.appoint(s.manager, [o(0), o(1), o(2)], { seats: 6 });
    for (let round = 0; round < ROUNDS; round++) {
      const board = (await g.staffBoard(s.manager))!;
      const seated = board.members.filter((m) => !m.endedAt);
      for (const m of seated.filter((x) => x.role === 'chair'))
        await g
          .http(
            'patch',
            `/staff/governance/board/members/${m.id}`,
            s.manager.token,
            { role: 'member' },
          )
          .expect(200);
      const [a, b] = seated;
      const res = await Promise.all(
        [a, b].map((m) =>
          g.http(
            'patch',
            `/staff/governance/board/members/${m.id}`,
            s.manager.token,
            {
              role: 'chair',
            },
          ),
        ),
      );
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(code(res.find((r) => r.status === 409)!)).toBe(
        'BOARD_OFFICE_TAKEN',
      );
    }
  });

  it('R11: a seat ended while its holder acts: the poll was put before the end, or refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const board = (await g.staffBoard(s.manager))!;
      const member: Who = s.owners.find((w) =>
        board.members.some((m) => m.accountId === w.id && !m.endedAt),
      )!;
      const seat = board.members.find(
        (m) => m.accountId === member.id && !m.endedAt,
      )!;
      const [ended, put] = await Promise.all([
        g.http(
          'post',
          `/staff/governance/board/members/${seat.id}/end`,
          s.manager.token,
          {
            reasonCode: 'resigned',
          },
        ),
        putPoll(member),
      ]);
      expect(ended.status).toBe(200);
      expect([201, 403]).toContain(put.status);
      if (put.status === 201) await putWhileSeated(member, put);
      else expect(code(put)).toMatch(/FORBIDDEN|BOARD_SEAT_REQUIRED/);
      // Seat them again for the next round.
      await g
        .http('post', '/staff/governance/board/members', s.manager.token, {
          accountId: member.id,
          role: 'member',
        })
        .expect(201);
    }
  });

  it('R12: a board succeeded while its member acts: the poll was put before the succession, or refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // An election counted and ready to certify, the board still sitting.
      const e = await g.election(s.manager);
      await g.stand(o(7), e.id).expect(201);
      await shiftElection(e.id, -25);
      await g.sweep(CONTEST_OPEN_SWEEP);
      const [c] = (await g.electionAs(o(7), e.id)).candidates;
      await g.electionVote(o(7), e.id, o(7).unitId, [c.id]).expect(201);
      await shiftElection(e.id, -25);
      await g.sweep(CONTEST_CLOSE_SWEEP);
      const board = (await g.staffBoard(s.manager))!;
      expect(board.status).toBe('current');
      const member: Who = s.owners.find((w) =>
        board.members.some((m) => m.accountId === w.id && !m.endedAt),
      )!;
      const [certified, put] = await Promise.all([
        g.http(
          'post',
          `/staff/governance/elections/${e.id}/certify`,
          s.manager.token,
          {},
        ),
        putPoll(member),
      ]);
      expect(certified.status).toBe(200);
      expect([201, 403]).toContain(put.status);
      if (put.status === 201) await putWhileSeated(member, put);
      else expect(code(put)).toMatch(/FORBIDDEN|BOARD_SEAT_REQUIRED/);
      const open = await g.inTx(s.c, (tx) =>
        tx.boardTerm.findMany({ where: { endedAt: null } }),
      );
      expect(open.map((t) => t.electionId)).toEqual([e.id]);
    }
  });
});
