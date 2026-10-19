import { auditReaders } from '../setup/audit';
import {
  boardMatterHelpers,
  type MotionBody,
  type Who,
} from '../setup/board-matters';
import { lapse } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;

/**
 * ADR 0055, the races of the board's count. A count is taken with every
 * seat of the board locked shared and the matter and the motion for
 * update, so:
 * - two votes that would each decide a motion: one decides it, once (one
 *   decision, one audit row, one notice each); the other is refused;
 * - a seat ended, a seat filled or the chair moved while a deciding vote
 *   counts: the count is the board's either before or after it, and the
 *   stored count says which;
 * - a request withdrawn while a vote decides it: one of the two;
 * - two motions proposed on one request: one opens, the other is refused
 *   (BOARD_MOTION_OPEN).
 */
describe('Governance — the board’s count, concurrently (ADR 0055)', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    s = await b.setUp(12, 3);
    read = auditReaders(h);
  }, 300_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const motionRow = (id: string) =>
    b.inTx(s.c, (tx) => tx.boardMotion.findUniqueOrThrow({ where: { id } }));

  /** A fresh board of `members`, the first chairing, seats to spare. */
  async function board(members: Who[]) {
    await lapse(s.term.id);
    s.term = await b.appoint(s.manager, members, { seats: 8 });
    return s.term;
  }
  const seatOf = (
    term: {
      members: { id: string; accountId: string; endedAt: string | null }[];
    },
    who: Who,
  ) => term.members.find((m) => m.accountId === who.id && !m.endedAt)!.id;

  it('two deciding votes at once: one carries it, once; the other is refused', async () => {
    await board([o(0), o(1), o(2)]);
    for (let round = 0; round < ROUNDS; round++) {
      const r = await b.raise(s.accountant);
      const m = await b.motion(o(0), r.id);
      await b.vote(o(0), m.id, 'for').expect(201);
      const [one, two] = await Promise.all([
        b.vote(o(1), m.id, 'for'),
        b.vote(o(2), m.id, 'for'),
      ]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expect(code([one, two].find((x) => x.status === 409)!)).toBe(
        'BOARD_MOTION_CLOSED',
      );
      expect(await motionRow(m.id)).toMatchObject({
        result: 'carried',
        votesFor: 2,
        sitting: 3,
      });
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'governance_approval.decided',
          targetId: r.id,
        }),
      ).toHaveLength(1);
      expect(
        (
          await b.notifications(
            s.c,
            s.accountant.id,
            'governance_approval.decided',
          )
        ).filter((n) => n.targetId === r.id),
      ).toHaveLength(1);
    }
  });

  it('a deciding vote while a seat is ended: counted with the seat, or without it', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const term = await board([o(0), o(1), o(2), o(3)]);
      const r = await b.raise(s.accountant);
      const m = await b.motion(o(0), r.id);
      await b.vote(o(0), m.id, 'for').expect(201);
      await b.vote(o(1), m.id, 'for').expect(201);
      // Four seats, 2–0: o(2)'s vote decides it (3 of 4). Ending o(3)'s seat
      // meanwhile makes three seats: decided either way.
      const [voted, ended] = await Promise.all([
        b.vote(o(2), m.id, 'for'),
        b.http(
          'post',
          `/staff/governance/board/members/${seatOf(term, o(3))}/end`,
          s.manager.token,
          { reasonCode: 'resigned' },
        ),
      ]);
      expect(voted.status).toBe(201);
      expect(ended.status).toBe(200);
      const motion = await motionRow(m.id);
      const seat = await b.inTx(s.c, (tx) =>
        tx.boardMember.findUniqueOrThrow({ where: { id: seatOf(term, o(3)) } }),
      );
      expect(motion.result).toBe('carried');
      // The count is the board's at its instant.
      expect(motion.sitting).toBe(motion.closedAt! <= seat.endedAt! ? 4 : 3);
    }
  });

  it('a deciding vote while a seat is filled: decided with three seats before it, or not yet with four after it', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await board([o(0), o(1), o(2)]);
      const r = await b.raise(s.accountant);
      const m = await b.motion(o(0), r.id);
      await b.vote(o(0), m.id, 'for').expect(201);
      const newcomer = o(4 + round);
      const [voted, added] = await Promise.all([
        b.vote(o(1), m.id, 'for'),
        b.http('post', '/staff/governance/board/members', s.manager.token, {
          accountId: newcomer.id,
          role: 'member',
        }),
      ]);
      expect(voted.status).toBe(201);
      expect(added.status).toBe(201);
      const motion = await motionRow(m.id);
      const seat = await b.inTx(s.c, (tx) =>
        tx.boardMember.findFirstOrThrow({
          where: { accountId: newcomer.id, endedAt: null },
        }),
      );
      if (motion.closedAt) {
        // 2 of 3 decided it, before the fourth seat.
        expect(motion).toMatchObject({ result: 'carried', sitting: 3 });
        expect(motion.closedAt <= seat.addedAt).toBe(true);
      } else {
        // 2 of 4 is below the quorum: still open.
        expect((motion as { result: string | null }).result).toBeNull();
        expect(
          (
            await b
              .http('get', `/board/approvals/${r.id}`, o(0).token)
              .expect(200)
          ).body,
        ).toMatchObject({ status: 'pending' });
      }
    }
  });

  it('a deciding vote while the chair is moved: the tie is broken by the chair of its instant', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const term = await board([o(0), o(1), o(2), o(3)]);
      const r = await b.raise(s.accountant);
      const m = await b.motion(o(1), r.id);
      // 1 for (the chair), 2 against: the last seat's for makes 2–2.
      await b.vote(o(0), m.id, 'for').expect(201);
      await b.vote(o(1), m.id, 'against').expect(201);
      await b.vote(o(2), m.id, 'against').expect(201);
      const [voted, moved] = await Promise.all([
        b.vote(o(3), m.id, 'for'),
        b.http(
          'patch',
          `/staff/governance/board/members/${seatOf(term, o(0))}`,
          s.manager.token,
          { role: 'member' },
        ),
      ]);
      expect(voted.status).toBe(201);
      expect(moved.status).toBe(200);
      const motion = await motionRow(m.id);
      const [closed] = await read.tenant(s.c.tenantId, {
        action: 'board_motion.closed',
        targetId: m.id,
      });
      // The count saw o(0) still chair (the tie carries) or no chair (it
      // fails), never a mix of the two.
      const chair = (closed.metadata as { chair: string | null }).chair;
      expect([seatOf(term, o(0)), null]).toContain(chair);
      expect(motion.result).toBe(chair ? 'carried' : 'failed');
    }
  });

  it('two motions proposed at once: one opens, the other is refused', async () => {
    await board([o(0), o(1), o(2)]);
    for (let round = 0; round < ROUNDS; round++) {
      const r = await b.raise(s.accountant);
      const [one, two] = await Promise.all([
        b.propose(o(0), r.id),
        b.propose(o(1), r.id, { outcome: 'reject' }),
      ]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expect(code([one, two].find((x) => x.status === 409)!)).toBe(
        'BOARD_MOTION_OPEN',
      );
      expect(
        await b.inTx(s.c, (tx) =>
          tx.boardMotion.count({ where: { approvalRequestId: r.id } }),
        ),
      ).toBe(1);
    }
  });

  it('a deciding vote while the request is withdrawn: one of the two', async () => {
    await board([o(0), o(1), o(2)]);
    for (let round = 0; round < ROUNDS; round++) {
      const r = await b.raise(s.accountant);
      const m = await b.motion(o(0), r.id);
      await b.vote(o(0), m.id, 'for').expect(201);
      const [voted, withdrawn] = await Promise.all([
        b.vote(o(1), m.id, 'for'),
        b.http(
          'post',
          `/staff/governance/approvals/${r.id}/withdraw`,
          s.accountant.token,
          { reasonCode: 'superseded' },
        ),
      ]);
      const view = await b.staffView(s.accountant, r.id);
      if (voted.status === 201) {
        expect((voted.body as MotionBody).status).toBe('carried');
        expect(withdrawn.status).toBe(409);
        expect(code(withdrawn)).toBe('APPROVAL_NOT_PENDING');
        expect(view.status).toBe('approved');
      } else {
        expect(voted.status).toBe(409);
        expect(code(voted)).toBe('BOARD_MOTION_CLOSED');
        expect(withdrawn.status).toBe(200);
        expect(view.status).toBe('withdrawn');
      }
    }
  });
});
