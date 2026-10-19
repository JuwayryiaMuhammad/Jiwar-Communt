import { boardAppealHelpers } from '../setup/board-appeals';
import type { Who } from '../setup/board-matters';
import { clock } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { lapse } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0055, a resident who sits on the board, as the manager dashboard
 * admits them by their derived `governance.board` (ADR 0051):
 * - they reach the board's routes while seated, and on the very next
 *   request after the seat goes (removed, the term ended, the account
 *   erased) they do not: nothing about the grant is cached, the same token
 *   is used before and after;
 * - their `/me` holds their own role's permissions and `governance.board`,
 *   nothing more, and every other management route refuses them;
 * - a member of one compound reaches nothing of another's board.
 */
describe('Governance — a resident board member’s access (ADR 0055)', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    s = await a.setUp(8, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const inbox = (who: Who) => a.http('get', '/board/approvals', who.token);

  /** A fresh board of `members`, the first chairing. */
  async function board(members: Who[]) {
    await lapse(s.term.id);
    s.term = await a.appoint(s.manager, members, { seats: 5 });
    return s.term;
  }
  const seatOf = (who: Who) =>
    s.term.members.find((m) => m.accountId === who.id && !m.endedAt)!.id;

  describe('the seat, request by request', () => {
    it('removed: the next request is refused, and /me no longer lists it', async () => {
      await board([o(0), o(1), o(2)]);
      await inbox(o(2)).expect(200);
      expect(await a.permissionsOf(o(2))).toContain('governance.board');
      await a
        .http(
          'post',
          `/staff/governance/board/members/${seatOf(o(2))}/end`,
          s.manager.token,
          { reasonCode: 'removed' },
        )
        .expect(200);
      await inbox(o(2)).expect(403);
      await a.http('get', '/board/overview', o(2).token).expect(403);
      expect(await a.permissionsOf(o(2))).not.toContain('governance.board');
      // The others still sit.
      await inbox(o(0)).expect(200);
    });

    it('the term ended: every member is refused on the next request', async () => {
      await board([o(0), o(1), o(2)]);
      for (const m of [o(0), o(1), o(2)]) await inbox(m).expect(200);
      await lapse(s.term.id);
      for (const m of [o(0), o(1), o(2)]) {
        await inbox(m).expect(403);
        expect(await a.permissionsOf(m)).not.toContain('governance.board');
      }
    });

    it('the account erased: its session ends with the seat, on the next request', async () => {
      // A co-owner: a unit's primary must hand it over before an erasure.
      const member = await a.owner(s.c, o(3).unitId);
      await board([o(0), o(1), member]);
      await inbox(member).expect(200);
      await eraseNow(h, s.c, member.id);
      await inbox(member).expect(401);
      await a.http('get', '/me', member.token).expect(401);
      // The system ended the seat: the board no longer counts it.
      const now = (await a.staffBoard(s.manager))!;
      expect(now.members.find((m) => m.accountId === member.id)).toMatchObject({
        endReason: 'account_closed',
      });
    });
  });

  describe('what the grant gives, and nothing more', () => {
    it('/me: their own role’s permissions and governance.board', async () => {
      await board([o(0), o(1), o(2)]);
      const plain = await a.permissionsOf(o(5));
      expect(plain).not.toContain('governance.board');
      expect([...(await a.permissionsOf(o(0)))].sort()).toEqual(
        [...plain, 'governance.board'].sort(),
      );
      const manager = await a.permissionsOf(s.manager);
      const managerOnly = manager.filter((p) => !plain.includes(p));
      expect(managerOnly.length).toBeGreaterThan(0);
      expect(
        (await a.permissionsOf(o(0))).filter((p) => managerOnly.includes(p)),
      ).toEqual([]);
    });

    it('every other management route refuses them', async () => {
      await board([o(0), o(1), o(2)]);
      for (const path of [
        '/staff/governance/approvals',
        '/staff/governance/settings',
        '/staff/governance/board-appeals',
        '/staff/governance/board',
        '/staff/governance/polls',
        '/staff/finance/budgets',
        '/staff/finance/expenses',
        '/staff/finance/expense-authorizations',
        '/staff/finance/budget-settings',
        '/staff/finance/reports/budget-vs-actual',
        '/staff/finance/reports/aging',
      ])
        expect({
          path,
          status: (await a.http('get', path, o(0).token)).status,
        }).toEqual({ path, status: 403 });
      for (const [path, body] of [
        [
          '/staff/governance/approvals',
          { type: 'legal_escalation', context: 'c', impact: 'i' },
        ],
        [
          '/staff/finance/budgets',
          { fiscalYear: Number(clock().today.slice(0, 4)) },
        ],
      ] as const)
        expect({
          path,
          status: (await a.http('post', path, o(0).token, body)).status,
        }).toEqual({ path, status: 403 });
    });
  });

  it('a member of one compound reaches nothing of another’s board', async () => {
    await board([o(0), o(1), o(2)]);
    const other = await a.setUp(4, 3);
    const request = await a.raise(other.accountant);
    const dispute = await a.rejectedDispute(
      other.manager,
      other.owners[3],
      other.owners[3].unitId,
    );
    const appeal = await a.appeal(other.owners[3], dispute);
    const motion = await a.motion(other.owners[0], request.id);

    expect(
      code(
        await a
          .http('get', `/board/approvals/${request.id}`, o(0).token)
          .expect(404),
      ),
    ).toBe('APPROVAL_NOT_FOUND');
    expect(
      code(
        await a
          .http('get', `/board/appeals/${appeal.id}`, o(0).token)
          .expect(404),
      ),
    ).toBe('BOARD_APPEAL_NOT_FOUND');
    expect(code(await a.propose(o(0), request.id).expect(404))).toBe(
      'APPROVAL_NOT_FOUND',
    );
    expect(code(await a.vote(o(0), motion.id, 'for').expect(404))).toBe(
      'BOARD_MOTION_NOT_FOUND',
    );
    for (const status of ['pending', 'approved', 'rejected', 'withdrawn']) {
      const approvals = (
        await a
          .http('get', `/board/approvals?status=${status}`, o(0).token)
          .expect(200)
      ).body as { data: { id: string }[] };
      expect(approvals.data.map((x) => x.id)).not.toContain(request.id);
    }
    const appeals = (
      await a
        .http('get', '/board/appeals?status=pending', o(0).token)
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(appeals.data.map((x) => x.id)).not.toContain(appeal.id);
    // The other board's motion is untouched.
    expect(
      await a.inTx(other.c, (tx) =>
        tx.boardVote.count({ where: { motionId: motion.id } }),
      ),
    ).toBe(0);
  });
});
