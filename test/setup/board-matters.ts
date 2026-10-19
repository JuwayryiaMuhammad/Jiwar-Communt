import { BOARD_MATTERS_SWEEP } from '../../src/governance/motions/matter-sweeps';
import type { Compound } from './community';
import { dbClock } from './compound-clock';
import { gateHelpers } from './gate';
import { governanceHelpers, superuserSql, type Who } from './governance';
import type { HttpHarness } from './http-app';

export type { Who };

export interface ApprovalBody {
  id: string;
  reference: string;
  type: string;
  status: string;
  cost: string | null;
  overdue: boolean;
  deadlineAt: string;
  decision: {
    decision: string;
    rationale: string;
    alternativesNote: string | null;
  } | null;
  implementation: { byDecision: boolean; note: string | null } | null;
}

export interface MotionBody {
  id: string;
  status: string;
  outcome: string;
  tally: { seats: number; quorum: number; for: number; against: number };
  votes: { memberId: string; choice: string }[];
  myVote: string | null;
  proposedByMe: boolean;
}

/**
 * Helpers for the board's matters (ADR 0055): a compound with owners, the
 * manager and an accountant (the system role), the board's requests and
 * motions over HTTP.
 */
export function boardMatterHelpers(h: HttpHarness) {
  const g = governanceHelpers(h);
  const { http } = g;

  /** A staff account of the compound's `accountant` role. */
  async function accountant(c: Compound): Promise<Who> {
    return g.who(c, (await gateHelpers(h).guard(c, 'accountant')).id, 'staff');
  }

  /** A compound with `owners` owners, `seats` of them seated (the first chairs). */
  async function setUp(owners = 6, seats = 3) {
    const s = await g.setUp(owners);
    const term = await g.appoint(s.manager, s.owners.slice(0, seats), {
      seats: Math.max(seats, 3) + 2,
    });
    return { ...s, term, accountant: await accountant(s.c) };
  }

  /** `POST /staff/governance/approvals` of a type that names no subject. */
  async function raise(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<ApprovalBody> {
    const res = await http('post', '/staff/governance/approvals', by.token, {
      type: 'exceptional_fee',
      context: 'A one-off fee for the pool’s repair',
      impact: 'Every unit pays once',
      cost: '1200.00',
      ...over,
    });
    if (res.status !== 201)
      throw new Error(`raise: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ApprovalBody;
  }

  const propose = (
    member: Who,
    requestId: string,
    over: Record<string, unknown> = {},
  ) =>
    http('post', `/board/approvals/${requestId}/motions`, member.token, {
      outcome: 'approve',
      rationale: 'Within the budget and needed now.',
      ...over,
    });

  async function motion(
    member: Who,
    requestId: string,
    over: Record<string, unknown> = {},
  ): Promise<MotionBody> {
    const res = await propose(member, requestId, over);
    if (res.status !== 201)
      throw new Error(`propose: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as MotionBody;
  }

  const vote = (member: Who, motionId: string, choice: 'for' | 'against') =>
    http('post', `/board/motions/${motionId}/votes`, member.token, { choice });

  const close = (member: Who, motionId: string) =>
    http('post', `/board/motions/${motionId}/close`, member.token, {});

  const staffView = async (as: Who, id: string): Promise<ApprovalBody> =>
    (
      await http('get', `/staff/governance/approvals/${id}`, as.token).expect(
        200,
      )
    ).body as ApprovalBody;

  /** A request's deadline moved into the past: time travel. */
  const overdue = (requestId: string) =>
    superuserSql(
      `UPDATE governance_approval_requests
          SET deadline_at = $2, created_at = $2::timestamptz - interval '14 days'
        WHERE id = $1`,
      [requestId, new Date(dbClock().getTime() - 60_000)],
    );

  /** One run of the board's matters sweep, at `now` (the database's clock). */
  const sweepMatters = (now: Date = dbClock()) =>
    g.sweep(BOARD_MATTERS_SWEEP, now);

  return {
    ...g,
    accountant,
    setUp,
    raise,
    propose,
    motion,
    vote,
    close,
    staffView,
    overdue,
    sweepMatters,
  };
}
