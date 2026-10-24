import { Client } from 'pg';
import type { Compound } from './community';
import { engagementHelpers, type Who } from './engagement';
import type { HttpHarness } from './http-app';
import { required } from './test-env';

export type { Who } from './engagement';

// eslint-disable-next-line no-restricted-syntax -- a real 24 h: the board term's length is checked in ms
const DAY = 86_400_000;

/** A board term as the staff view returns it. */
export interface StaffTermBody {
  id: string;
  source: string;
  seats: number;
  status: string;
  startsAt: string;
  endsAt: string;
  endedAt: string | null;
  endReason: string | null;
  members: {
    id: string;
    accountId: string;
    role: string;
    fullName: string | null;
    endedAt: string | null;
    endReason: string | null;
  }[];
}

/** A poll as the owners' view returns it. */
export interface PollBody {
  id: string;
  reference: string;
  kind: string;
  secret: boolean;
  rollCallPublic: boolean;
  status: string;
  electorate: number | null;
  turnout: number | null;
  result: string | null;
  winningOptionId: string | null;
  options: { id: string; key: string | null; votes: number | null }[];
  myUnits: {
    unitId: string;
    unitCode: string;
    voted: boolean;
    mayVote: boolean;
  }[];
  rollCall: { unitCode: string; choice: string[] }[] | null;
}

/** An election as the owners' view returns it. */
export interface ElectionBody {
  id: string;
  reference: string;
  phase: string;
  seats: number;
  electorate: number | null;
  turnout: number | null;
  tiedCandidateIds: string[];
  termId: string | null;
  certifiedAt: string | null;
  cancelReasonCode: string | null;
  candidates: {
    id: string;
    fullName: string | null;
    statement: string | null;
    votes: number | null;
    outcome: string | null;
  }[];
  myUnits: { unitId: string; voted: boolean; mayVote: boolean }[];
  myCandidacy: { id: string; status: string; statement: string | null } | null;
}

/**
 * Rewrites governance rows over a superuser connection with
 * `session_replication_role = replica`, which skips the immutability
 * triggers: TEST-ONLY time travel, as the SLA's time machine (ADR 0034).
 */
export async function superuserSql(
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(sql, params);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

/** Moves a contest's window (and its creation) by `hours`: time travel. */
export const shiftContest = (contestId: string, hours: number) =>
  superuserSql(
    `UPDATE governance_contests
        SET opens_at = opens_at + make_interval(hours => $2),
            closes_at = closes_at + make_interval(hours => $2),
            opened_at = opened_at + make_interval(hours => $2),
            created_at = created_at + make_interval(hours => $2)
      WHERE id = $1`,
    [contestId, hours],
  );

/** Moves an election's dates and its contest's window by `hours`. */
export const shiftElection = async (electionId: string, hours: number) => {
  await superuserSql(
    `UPDATE governance_elections
        SET nominations_open_at = nominations_open_at + make_interval(hours => $2),
            nominations_close_at = nominations_close_at + make_interval(hours => $2),
            created_at = created_at + make_interval(hours => $2)
      WHERE id = $1`,
    [electionId, hours],
  );
  await superuserSql(
    `UPDATE governance_contests c
        SET opens_at = c.opens_at + make_interval(hours => $2),
            closes_at = c.closes_at + make_interval(hours => $2),
            opened_at = c.opened_at + make_interval(hours => $2),
            created_at = c.created_at + make_interval(hours => $2)
       FROM governance_elections e
      WHERE e.id = $1 AND c.id = e.contest_id`,
    [electionId, hours],
  );
};

/** Moves a term's end into the past: the board lapses. */
export const lapse = (termId: string) =>
  superuserSql(
    `UPDATE board_terms
        SET starts_at = now() - interval '400 days',
            ends_at = now() - interval '1 second',
            created_at = now() - interval '400 days'
      WHERE id = $1`,
    [termId],
  );

/**
 * Helpers for the governance suites (ADR 0051): a compound whose units
 * each have an owner, the manager, and the board over HTTP.
 */
export function governanceHelpers(h: HttpHarness) {
  const e = engagementHelpers(h);
  const { http, who } = e;

  /** Ends every active occupancy of the account in the unit: they moved out. */
  async function moveOut(c: Compound, unitId: string, account: Who) {
    for (const o of await e.x.occupancies(c, unitId))
      if (o.accountId === account.id && o.status === 'active')
        await e.x.asManager(c, () =>
          e.x.residents.endOccupancy(o.id, {
            code: 'moved_out',
            text: 'Moved out',
          }),
        );
  }

  /** A unit and the owner who lives there (its primary). */
  async function ownerOfNewUnit(
    c: Compound,
  ): Promise<Who & { unitId: string }> {
    const unit = await e.unit(c, 'A');
    return { ...(await e.owner(c, unit.id)), unitId: unit.id };
  }

  /** A compound, its manager and `owners` owners of a unit each. */
  async function setUp(owners = 4) {
    const c = await e.x.compound('Governance Court');
    const manager = await who(c, c.managerId, 'manager');
    const o: (Who & { unitId: string })[] = [];
    for (let i = 0; i < owners; i++) o.push(await ownerOfNewUnit(c));
    return { c, manager, owners: o };
  }

  // eslint-disable-next-line test-clock/day-multiple -- a real 365 × 24 h: a term ends at an instant; its length is checked in ms
  const inAYear = () => new Date(Date.now() + 365 * DAY).toISOString();

  /** `POST /staff/governance/board/appoint`: the first member chairs. */
  async function appoint(
    manager: Who,
    members: Who[],
    over: Record<string, unknown> = {},
  ): Promise<StaffTermBody> {
    const res = await http(
      'post',
      '/staff/governance/board/appoint',
      manager.token,
      {
        seats: Math.max(members.length, 3),
        endsAt: inAYear(),
        members: members.map((m, i) => ({
          accountId: m.id,
          role: i === 0 ? 'chair' : 'member',
        })),
        ...over,
      },
    );
    if (res.status !== 201)
      throw new Error(`appoint: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as StaffTermBody;
  }

  const staffBoard = async (manager: Who): Promise<StaffTermBody | null> =>
    (
      (await http('get', '/staff/governance/board', manager.token).expect(200))
        .body as { board: StaffTermBody | null }
    ).board;

  /** `POST /governance/polls`: a yes/no poll open now, secret, for 3 days. */
  async function poll(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<PollBody> {
    const res = await http('post', '/governance/polls', by.token, {
      kind: 'yes_no',
      titleEn: 'Repaint the fence',
      bodyEn: 'Green or not green.',
      secret: true,
      quorumPct: 50,
      thresholdPct: 50,
      closesAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      ...over,
    });
    if (res.status !== 201)
      throw new Error(`poll: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as PollBody;
  }

  const pollAs = async (as: Who, id: string): Promise<PollBody> =>
    (await http('get', `/governance/polls/${id}`, as.token).expect(200))
      .body as PollBody;

  const castVote = (
    as: Who,
    pollId: string,
    unitId: string,
    optionIds: string[],
    headers: Record<string, string> = {},
  ) =>
    http(
      'post',
      `/governance/polls/${pollId}/votes`,
      as.token,
      { unitId, optionIds },
      headers,
    );

  /** A poll's contest id. */
  const contestOf = (c: Compound, pollId: string): Promise<string> =>
    e.inTx(
      c,
      async (tx) =>
        (await tx.governancePoll.findUniqueOrThrow({ where: { id: pollId } }))
          .contestId,
    );

  /** The option of a yes/no poll with `key`. */
  const option = (p: PollBody, key: string) =>
    p.options.find((o) => o.key === key)!.id;

  /**
   * `POST /governance/elections`: 3 seats, nominations open now for 25
   * hours (the shortest window is a day, by the server's clock), voting the
   * day after.
   */
  async function election(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<ElectionBody> {
    const at = (hours: number) =>
      new Date(Date.now() + hours * 3_600_000).toISOString();
    const res = await http('post', '/governance/elections', by.token, {
      titleEn: 'The board, 2027',
      bodyEn: 'Three seats.',
      seats: 3,
      termMonths: 24,
      nominationsCloseAt: at(25),
      votingOpensAt: at(25),
      votingClosesAt: at(49),
      ...over,
    });
    if (res.status !== 201)
      throw new Error(`election: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ElectionBody;
  }

  const electionAs = async (as: Who, id: string): Promise<ElectionBody> =>
    (await http('get', `/governance/elections/${id}`, as.token).expect(200))
      .body as ElectionBody;

  const stand = (as: Who, id: string, statement?: string) =>
    http('post', `/governance/elections/${id}/candidacy`, as.token, {
      ...(statement ? { statement } : {}),
    });

  const electionVote = (
    as: Who,
    id: string,
    unitId: string,
    candidateIds: string[],
  ) =>
    http('post', `/governance/elections/${id}/votes`, as.token, {
      unitId,
      candidateIds,
    });

  /** The account's permissions now, as `GET /me` lists them. */
  const permissionsOf = async (as: Who): Promise<string[]> =>
    (
      (await http('get', '/me', as.token).expect(200)).body as {
        permissions: string[];
      }
    ).permissions;

  return {
    ...e,
    moveOut,
    ownerOfNewUnit,
    setUp,
    appoint,
    staffBoard,
    permissionsOf,
    inAYear,
    poll,
    pollAs,
    castVote,
    option,
    contestOf,
    election,
    electionAs,
    stand,
    electionVote,
  };
}
