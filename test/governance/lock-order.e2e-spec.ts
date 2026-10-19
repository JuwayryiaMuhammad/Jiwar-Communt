import {
  CONTEST_CLOSE_SWEEP,
  CONTEST_OPEN_SWEEP,
} from '../../src/governance/contests/contest-sweeps';
import { dbClock } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import {
  governanceHelpers,
  lapse,
  shiftElection,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;
const HOUR = 3_600_000;
const later = (hours: number) =>
  new Date(dbClock().getTime() + hours * HOUR).toISOString();

/**
 * ADR 0055, the lock order of ADR 0051 kept where R7a broke it. Each race
 * runs three writes that, before the fix, could wait on each other in a
 * cycle (PostgreSQL aborts one: a 500). Now each finishes, and what it
 * left agrees with the history:
 * - a member's poll that opens at once, an erasure of one of its electors
 *   (that account, then the board lock), and the end of the member's seat
 *   (the board lock, then the seat);
 * - the same with an election whose nominations open at once, which tells
 *   every owner;
 * - a member cancelling an election while the manager certifies it (the
 *   term before the contest, at both).
 */
describe('Governance — lock order (ADR 0055)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(5);
    await g.appoint(s.manager, s.owners.slice(0, 3), { seats: 6 });
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  /** The member's seat now. */
  const seatOf = async (member: Who) =>
    (await g.staffBoard(s.manager))!.members.find(
      (m) => m.accountId === member.id && !m.endedAt,
    )!;

  /**
   * A unit its landlord rents out: the landlord is its voting owner (the
   * primary is a tenant) and, not being a primary, may be erased.
   */
  async function rentedOut(): Promise<Who> {
    const unit = await g.unit(s.c);
    await g.tenant(s.c, unit.id);
    return g.landlord(s.c, unit.id);
  }

  /** Whether the history shows the account seated, on a board sitting, at `at`. */
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

  const endSeat = (seatId: string) =>
    g.http(
      'post',
      `/staff/governance/board/members/${seatId}/end`,
      s.manager.token,
      { reasonCode: 'resigned' },
    );

  const reseat = (member: Who) =>
    g
      .http('post', '/staff/governance/board/members', s.manager.token, {
        accountId: member.id,
        role: 'member',
      })
      .expect(201);

  /** Settles all three; an erasure that threw (a deadlock among them) fails the test. */
  async function race<A, B, C>(
    a: Promise<A>,
    b: Promise<B>,
    c: Promise<C>,
  ): Promise<[A, B, C]> {
    const settled = await Promise.allSettled([a, b, c]);
    for (const r of settled)
      if (r.status === 'rejected') throw r.reason as Error;
    return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as [
      A,
      B,
      C,
    ];
  }

  it('a member’s poll opening at once, an elector’s erasure and the seat’s end all finish', async () => {
    const member = o(1);
    for (let round = 0; round < ROUNDS; round++) {
      const elector = await rentedOut();
      const seat = await seatOf(member);
      const [put, , ended] = await race(
        g.http('post', '/governance/polls', member.token, {
          kind: 'yes_no',
          titleEn: 'Race',
          bodyEn: 'Race.',
          secret: true,
          quorumPct: 50,
          thresholdPct: 50,
          closesAt: later(48),
        }),
        eraseNow(h, s.c, elector.id),
        endSeat(seat.id),
      );
      expect(ended.status).toBe(200);
      expect([201, 403, 409]).toContain(put.status);
      if (put.status === 201) {
        const id = (put.body as { id: string }).id;
        const poll = await g.inTx(s.c, (tx) =>
          tx.governancePoll.findUniqueOrThrow({ where: { id } }),
        );
        expect(await satAt(member.id, poll.createdAt)).toBe(true);
        // Opened at once: the electorate is the snapshot of that moment.
        const contest = await g.inTx(s.c, (tx) =>
          tx.governanceContest.findUniqueOrThrow({
            where: { id: poll.contestId },
          }),
        );
        expect(contest.openedAt).not.toBeNull();
        await g
          .http('post', `/governance/polls/${id}/cancel`, s.manager.token, {
            reasonCode: 'other',
          })
          .expect(200);
      } else if (put.status === 409) {
        expect(code(put)).toBe('GOVERNANCE_BUSY');
      } else {
        expect(code(put)).toBe('BOARD_SEAT_REQUIRED');
      }
      await reseat(member);
    }
  });

  it('a member’s election opening its nominations at once, an owner’s erasure and the seat’s end all finish', async () => {
    const member = o(2);
    for (let round = 0; round < ROUNDS; round++) {
      const owner = await rentedOut();
      const seat = await seatOf(member);
      const [put, , ended] = await race(
        g.http('post', '/governance/elections', member.token, {
          titleEn: 'Race',
          bodyEn: 'Race.',
          seats: 3,
          termMonths: 24,
          nominationsCloseAt: later(25),
          votingOpensAt: later(25),
          votingClosesAt: later(49),
        }),
        eraseNow(h, s.c, owner.id),
        endSeat(seat.id),
      );
      expect(ended.status).toBe(200);
      expect([201, 403, 409]).toContain(put.status);
      if (put.status === 201) {
        const id = (put.body as { id: string }).id;
        const election = await g.inTx(s.c, (tx) =>
          tx.governanceElection.findUniqueOrThrow({ where: { id } }),
        );
        expect(await satAt(member.id, election.createdAt)).toBe(true);
        expect(election.nominationsNotifiedAt).not.toBeNull();
        await g
          .http('post', `/governance/elections/${id}/cancel`, s.manager.token, {
            reasonCode: 'other',
          })
          .expect(200);
      } else if (put.status === 409) {
        expect(code(put)).toBe('GOVERNANCE_BUSY');
      } else {
        expect(code(put)).toBe('BOARD_SEAT_REQUIRED');
      }
      await reseat(member);
    }
  });

  it('a member cancelling an election while the manager certifies it: one wins, nothing deadlocks', async () => {
    const member = o(0);
    for (let round = 0; round < ROUNDS; round++) {
      const e = await g.election(s.manager);
      await g.stand(o(4), e.id).expect(201);
      await shiftElection(e.id, -25);
      await g.sweep(CONTEST_OPEN_SWEEP);
      const [c] = (await g.electionAs(o(4), e.id)).candidates;
      await g.electionVote(o(4), e.id, o(4).unitId, [c.id]).expect(201);
      await shiftElection(e.id, -25);
      await g.sweep(CONTEST_CLOSE_SWEEP);
      const [certified, cancelled] = await Promise.all([
        g.http(
          'post',
          `/staff/governance/elections/${e.id}/certify`,
          s.manager.token,
          {},
        ),
        g.http('post', `/governance/elections/${e.id}/cancel`, member.token, {
          reasonCode: 'other',
        }),
      ]);
      const statuses = [certified.status, cancelled.status];
      // The certification replaced the board: a cancel after it finds no seat.
      expect(
        [
          [200, 403],
          [200, 409],
          [409, 200],
        ].map((p) => p.join()),
      ).toContain(statuses.join());
      if (certified.status === 200) {
        // Seat the original board again for the next round.
        const board = (await g.staffBoard(s.manager))!;
        await superseded(board.id);
      }
    }
  });

  /** After a certification, the old board back (lapse the new, appoint the old). */
  async function superseded(termId: string) {
    await lapse(termId);
    await g.appoint(s.manager, s.owners.slice(0, 3), { seats: 6 });
  }
});
