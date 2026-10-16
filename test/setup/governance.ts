import { Client } from 'pg';
import type { Compound } from './community';
import { engagementHelpers, type Who } from './engagement';
import type { HttpHarness } from './http-app';
import { required } from './test-env';

export type { Who } from './engagement';

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

  /** The account's permissions now, as `GET /me` lists them. */
  const permissionsOf = async (as: Who): Promise<string[]> =>
    (
      (await http('get', '/me', as.token).expect(200)).body as {
        permissions: string[];
      }
    ).permissions;

  return {
    ...e,
    ownerOfNewUnit,
    setUp,
    appoint,
    staffBoard,
    permissionsOf,
    inAYear,
  };
}
