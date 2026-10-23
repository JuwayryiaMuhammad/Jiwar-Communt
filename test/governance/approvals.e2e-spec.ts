import {
  boardMatterHelpers,
  type MotionBody,
  type Who,
} from '../setup/board-matters';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { lapse } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0055, approval requests: the staff put a decision package to the
 * board; the board decides it by motions of its sitting seats (a quorum of
 * a majority of seats, a majority of the votes cast, a tie the chair's);
 * the manager marks it implemented. Who may and may not, what each sees,
 * the deadlines, lapses and the overdue notice.
 */
describe('Governance — approval requests (ADR 0055)', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    // Seven owners; o(0) chairs a board of o(0), o(1), o(2).
    s = await b.setUp(7, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const motionOf = (res: { body: unknown }) => res.body as MotionBody;

  describe('who may and may not', () => {
    it('the manager and the accountant raise; a board member, an owner and a guard do not', async () => {
      await b.raise(s.manager);
      await b.raise(s.accountant);
      for (const who of [o(1), o(5)])
        await b
          .http('post', '/staff/governance/approvals', who.token, {
            type: 'legal_escalation',
            context: 'c',
            impact: 'i',
          })
          .expect(403);
    });

    it('only a sitting member reads the board’s inbox and votes; not the manager, the accountant or an owner off the board', async () => {
      for (const who of [s.manager, s.accountant, o(5)]) {
        await b.http('get', '/board/approvals', who.token).expect(403);
        await b
          .http(
            'post',
            `/board/motions/${'0'.repeat(8)}-0000-7000-8000-000000000000/votes`,
            who.token,
            {
              choice: 'for',
            },
          )
          .expect(403);
      }
      await b.http('get', '/board/approvals', o(1).token).expect(200);
    });

    it('the accountant reads the settings but only the manager changes them or marks a request implemented', async () => {
      await b
        .http('get', '/staff/governance/settings', s.accountant.token)
        .expect(200);
      await b
        .http('patch', '/staff/governance/settings', s.accountant.token, {
          items: [{ type: 'legal_escalation', deadlineDays: 7 }],
        })
        .expect(403);
      const r = await b.raise(s.accountant);
      await b
        .http(
          'post',
          `/staff/governance/approvals/${r.id}/implemented`,
          s.accountant.token,
          {},
        )
        .expect(403);
    });
  });

  describe('the package and the decision', () => {
    it('raised: numbered, its deadline from the settings, the board told by its type; the staff never see a motion', async () => {
      const r = await b.raise(s.accountant, {
        alternatives: [
          { text: 'Defer to next year' },
          { text: 'Pay from the reserve', cost: '900.00' },
        ],
      });
      expect(r.reference).toMatch(/^AR-\d{4}$/);
      expect(r.status).toBe('pending');
      const days =
        (new Date(r.deadlineAt).getTime() -
          new Date((r as unknown as { raisedAt: string }).raisedAt).getTime()) /
        // eslint-disable-next-line no-restricted-syntax -- a real 24 h: the deadline is raisedAt + days × 24 h, in ms
        86_400_000;
      expect(days).toBe(14);
      for (const member of [o(0), o(1), o(2)]) {
        const told = (
          await b.notifications(s.c, member.id, 'governance_approval.raised')
        ).filter((n) => n.targetId === r.id);
        expect(told).toHaveLength(1);
        expect(told[0].params).toEqual({ type: 'exceptional_fee' });
      }
      await b.motion(o(0), r.id);
      const staff = await b.staffView(s.accountant, r.id);
      expect(JSON.stringify(staff)).not.toContain('motions');
      expect(JSON.stringify(staff)).not.toContain('Within the budget');
    });

    it('a majority of the seats carries it at once: approved, with its reasons, told to who raised it, the manager and the board', async () => {
      const r = await b.raise(s.accountant);
      const m = await b.motion(o(1), r.id, {
        rationale: 'The repair cannot wait.',
        alternativesNote: 'Deferring risks the pool.',
      });
      expect(motionOf(await b.vote(o(1), m.id, 'for').expect(201)).status).toBe(
        'open',
      );
      const carried = motionOf(await b.vote(o(2), m.id, 'for').expect(201));
      expect(carried).toMatchObject({
        status: 'carried',
        tally: { seats: 3, quorum: 2, for: 2, against: 0 },
      });
      const staff = await b.staffView(s.accountant, r.id);
      expect(staff).toMatchObject({
        status: 'approved',
        decision: {
          decision: 'approved',
          rationale: 'The repair cannot wait.',
          alternativesNote: 'Deferring risks the pool.',
        },
        implementation: null,
      });
      for (const who of [s.accountant, s.manager, o(0)]) {
        const told = (
          await b.notifications(s.c, who.id, 'governance_approval.decided')
        ).filter((n) => n.targetId === r.id);
        expect(told).toHaveLength(1);
        expect(told[0].params).toEqual({
          type: 'exceptional_fee',
          decision: 'approved',
        });
      }
      // Decided: no vote, no new motion.
      expect(code(await b.vote(o(0), m.id, 'against').expect(409))).toBe(
        'BOARD_MOTION_CLOSED',
      );
      expect(code(await b.propose(o(0), r.id).expect(409))).toBe(
        'BOARD_MATTER_DECIDED',
      );
    });

    it('a motion to reject that carries rejects it; a failed motion leaves it pending for another', async () => {
      const r = await b.raise(s.manager, {
        type: 'legal_escalation',
        cost: undefined,
      });
      const first = await b.motion(o(0), r.id);
      await b.vote(o(0), first.id, 'against').expect(201);
      const failed = motionOf(
        await b.vote(o(1), first.id, 'against').expect(201),
      );
      expect(failed.status).toBe('failed');
      expect((await b.staffView(s.manager, r.id)).status).toBe('pending');
      const second = await b.motion(o(2), r.id, {
        outcome: 'reject',
        rationale: 'Not for the board.',
      });
      await b.vote(o(0), second.id, 'for').expect(201);
      await b.vote(o(2), second.id, 'for').expect(201);
      expect(await b.staffView(s.manager, r.id)).toMatchObject({
        status: 'rejected',
        decision: { decision: 'rejected', rationale: 'Not for the board.' },
      });
    });

    it('one open motion per request; a vote once; only its proposer withdraws it', async () => {
      const r = await b.raise(s.manager);
      const m = await b.motion(o(0), r.id);
      expect(code(await b.propose(o(1), r.id).expect(409))).toBe(
        'BOARD_MOTION_OPEN',
      );
      expect(m.proposedByMe).toBe(true);
      expect(
        motionOf(await b.vote(o(1), m.id, 'against').expect(201)).proposedByMe,
      ).toBe(false);
      expect(code(await b.vote(o(1), m.id, 'for').expect(409))).toBe(
        'BOARD_ALREADY_VOTED',
      );
      expect(
        code(
          await b
            .http('post', `/board/motions/${m.id}/withdraw`, o(1).token, {})
            .expect(403),
        ),
      ).toBe('BOARD_MOTION_NOT_YOURS');
      expect(
        motionOf(
          await b
            .http('post', `/board/motions/${m.id}/withdraw`, o(0).token, {})
            .expect(200),
        ).status,
      ).toBe('withdrawn');
      await b.motion(o(1), r.id);
    });
  });

  describe('the count', () => {
    let chair: Who;

    beforeAll(async () => {
      // A board of four: o(3) chairs, then o(4), o(5), o(6).
      await lapse(s.term.id);
      s.term = await b.appoint(s.manager, [o(3), o(4), o(5), o(6)], {
        seats: 5,
      });
      chair = o(3);
    });

    it('a tie of every seat is the chair’s vote', async () => {
      // The chair votes last: until then the remaining seats could still
      // change the result.
      for (const [others, chairVote, result] of [
        [['for', 'against', 'against'], 'for', 'carried'],
        [['for', 'for', 'against'], 'against', 'failed'],
      ] as const) {
        const r = await b.raise(s.manager);
        const m = await b.motion(o(4), r.id);
        for (const [i, choice] of others.entries()) {
          const after = motionOf(
            await b.vote(o(4 + i), m.id, choice).expect(201),
          );
          expect(after.status).toBe('open');
        }
        const last = motionOf(await b.vote(chair, m.id, chairVote).expect(201));
        expect(last).toMatchObject({
          status: result,
          tally: { seats: 4, for: 2, against: 2 },
        });
      }
    });

    it('not decided before the deadline (BOARD_VOTE_NOT_DUE); after it, as the votes stand with a quorum, or BOARD_QUORUM_NOT_MET', async () => {
      const r = await b.raise(s.manager);
      const m = await b.motion(o(4), r.id);
      await b.vote(o(4), m.id, 'for').expect(201);
      await b.vote(o(5), m.id, 'for').expect(201);
      expect(code(await b.close(o(4), m.id).expect(409))).toBe(
        'BOARD_VOTE_NOT_DUE',
      );
      await b.overdue(r.id);
      // Two of four: below the quorum of three.
      const short = await b.close(o(4), m.id).expect(409);
      expect(short.body).toMatchObject({
        code: 'BOARD_QUORUM_NOT_MET',
        params: { cast: 2, quorum: 3 },
      });
      await b.vote(o(6), m.id, 'against').expect(201);
      // Three of four, 2–1, the chair silent: carried as it stands.
      expect(motionOf(await b.close(o(5), m.id).expect(200))).toMatchObject({
        status: 'carried',
        tally: { for: 2, against: 1 },
      });
      expect((await b.staffView(s.manager, r.id)).status).toBe('approved');
    });

    it('a motion of a board that no longer sits lapses: a vote is refused, the sweep closes it, the next board proposes again', async () => {
      const r = await b.raise(s.manager);
      const m = await b.motion(o(4), r.id);
      await lapse(s.term.id);
      const next = await b.appoint(s.manager, [o(0), o(1), o(2)], { seats: 5 });
      // Off the board now: the derived permission is gone (403).
      await b.vote(o(4), m.id, 'for').expect(403);
      expect(code(await b.vote(o(0), m.id, 'for').expect(409))).toBe(
        'BOARD_MOTION_LAPSED',
      );
      await b.sweepMatters();
      const closed = await b.inTx(s.c, (tx) =>
        tx.boardMotion.findUniqueOrThrow({ where: { id: m.id } }),
      );
      expect(closed).toMatchObject({ result: 'lapsed', closedById: null });
      await b.motion(o(0), r.id);
      s.term = next;
    });
  });

  describe('after the decision, and around it', () => {
    it('withdrawn by who raised it (its open motion closes), or by the manager; not by other staff', async () => {
      const r = await b.raise(s.accountant);
      const m = await b.motion(o(0), r.id);
      const other = await b.accountant(s.c);
      expect(
        code(
          await b
            .http(
              'post',
              `/staff/governance/approvals/${r.id}/withdraw`,
              other.token,
              {
                reasonCode: 'other',
              },
            )
            .expect(403),
        ),
      ).toBe('APPROVAL_NOT_YOURS');
      await b
        .http(
          'post',
          `/staff/governance/approvals/${r.id}/withdraw`,
          s.accountant.token,
          {
            reasonCode: 'superseded',
          },
        )
        .expect(200);
      const closed = await b.inTx(s.c, (tx) =>
        tx.boardMotion.findUniqueOrThrow({ where: { id: m.id } }),
      );
      expect(closed).toMatchObject({
        result: 'withdrawn',
        closedById: s.accountant.id,
      });
      expect(code(await b.vote(o(1), m.id, 'for').expect(409))).toBe(
        'BOARD_MOTION_CLOSED',
      );
      const byManager = await b.raise(s.accountant);
      await b
        .http(
          'post',
          `/staff/governance/approvals/${byManager.id}/withdraw`,
          s.manager.token,
          {
            reasonCode: 'no_longer_needed',
          },
        )
        .expect(200);
    });

    it('the manager marks an approved request implemented, once; the board is told', async () => {
      const r = await b.raise(s.accountant);
      const pending = await b
        .http(
          'post',
          `/staff/governance/approvals/${r.id}/implemented`,
          s.manager.token,
          {},
        )
        .expect(409);
      expect(code(pending)).toBe('APPROVAL_NOT_APPROVED');
      const m = await b.motion(o(0), r.id);
      await b.vote(o(0), m.id, 'for').expect(201);
      await b.vote(o(1), m.id, 'for').expect(201);
      await b
        .http(
          'post',
          `/staff/governance/approvals/${r.id}/implemented`,
          s.manager.token,
          {
            note: 'Billed in March',
          },
        )
        .expect(200);
      expect((await b.staffView(s.accountant, r.id)).implementation).toEqual({
        implementedAt: expect.any(String) as string,
        byDecision: false,
        note: 'Billed in March',
      });
      expect(
        code(
          await b
            .http(
              'post',
              `/staff/governance/approvals/${r.id}/implemented`,
              s.manager.token,
              {},
            )
            .expect(409),
        ),
      ).toBe('APPROVAL_ALREADY_IMPLEMENTED');
      expect(
        (
          await b.notifications(s.c, o(2).id, 'governance_approval.implemented')
        ).filter((n) => n.targetId === r.id),
      ).toHaveLength(1);
    });

    it('overdue: the board and the manager are told once; the inbox says so', async () => {
      const r = await b.raise(s.accountant);
      await b.overdue(r.id);
      await b.sweepMatters();
      await b.sweepMatters();
      for (const who of [o(0), s.manager])
        expect(
          (
            await b.notifications(s.c, who.id, 'governance_approval.overdue')
          ).filter((n) => n.targetId === r.id),
        ).toHaveLength(1);
      expect((await b.staffView(s.accountant, r.id)).overdue).toBe(true);
      const list = await b
        .http('get', '/board/approvals?status=pending&overdue=true', o(0).token)
        .expect(200);
      expect(
        (list.body as { data: { id: string }[] }).data.map((x) => x.id),
      ).toContain(r.id);
    });

    it('the settings: a threshold only for the thresholded types; a new deadline applies to what is raised next', async () => {
      const bad = await b
        .http('patch', '/staff/governance/settings', s.manager.token, {
          items: [{ type: 'legal_escalation', threshold: '100.00' }],
        })
        .expect(400);
      expect((bad.body as { fields: unknown[] }).fields).toEqual([
        { field: 'items[0].threshold', code: 'FIELD_NOT_ALLOWED' },
      ]);
      await b
        .http('patch', '/staff/governance/settings', s.manager.token, {
          items: [
            { type: 'legal_escalation', deadlineDays: 3 },
            { type: 'major_contract', threshold: '50000.00' },
          ],
        })
        .expect(200);
      const r = await b.raise(s.manager, {
        type: 'legal_escalation',
        cost: undefined,
      });
      expect(
        (new Date(r.deadlineAt).getTime() -
          new Date((r as unknown as { raisedAt: string }).raisedAt).getTime()) /
          // eslint-disable-next-line no-restricted-syntax -- a real 24 h: the deadline is raisedAt + days × 24 h, in ms
          86_400_000,
      ).toBe(3);
      const contract = await b.raise(s.manager, {
        type: 'major_contract',
        cost: '80000.00',
      });
      expect((contract as unknown as { threshold: string }).threshold).toBe(
        '50000.00',
      );
    });

    it('a package’s shape by its type: a budget’s subject and cost, a contract’s cost', async () => {
      const res = await b
        .http('post', '/staff/governance/approvals', s.manager.token, {
          type: 'major_contract',
          context: 'c',
          impact: 'i',
          budgetId: '0193b8a4-0000-7000-8000-000000000000',
        })
        .expect(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        { field: 'budgetId', code: 'FIELD_NOT_ALLOWED' },
        { field: 'cost', code: 'FIELD_REQUIRED' },
      ]);
    });
  });
  describe('the export', () => {
    it('a member’s export holds its motions and its own votes; nobody else’s choice', async () => {
      const r = await b.raise(s.accountant);
      const m = await b.motion(o(1), r.id, { rationale: 'EXPORT-REASONS' });
      await b.vote(o(1), m.id, 'against').expect(201);
      await b.vote(o(2), m.id, 'for').expect(201);
      const email = (
        await b.x.asManager(s.c, () =>
          b.x.prisma.tenant.account.findUniqueOrThrow({
            where: { id: o(1).id },
          }),
        )
      ).email!;
      await stepUp(h, o(1).token, email);
      const asked = await b
        .http('post', '/me/data-exports', o(1).token, {})
        .expect(201);
      await buildExports(h);
      const dl = await b
        .http(
          'get',
          `/me/data-exports/${(asked.body as { id: string }).id}/download`,
          o(1).token,
        )
        .expect(200);
      const archive = await readArchive((dl.body as { url: string }).url);
      const board = JSON.parse(archive.text('governance/board-votes.json')) as {
        motionsProposed: { matter: { reference: string }; rationale: string }[];
        votes: { matter: { reference: string }; choice: string }[];
      };
      expect(board.motionsProposed).toContainEqual(
        expect.objectContaining({
          matter: expect.objectContaining({
            reference: r.reference,
          }) as object,
          rationale: 'EXPORT-REASONS',
        }),
      );
      const mine = board.votes.filter(
        (v) => v.matter.reference === r.reference,
      );
      expect(mine).toEqual([expect.objectContaining({ choice: 'against' })]);
    });
  });
});
