import { Client } from 'pg';
import { POLL_CLOSE_SWEEP } from '../../src/engagement/polls/polls.service';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

/**
 * ADR 0040: a vote and the end of its poll never interleave. A vote
 * share-locks the poll's row and a close takes it for update, so each sees
 * the other's commit and decides after it, by the database's clock. Every
 * ballot is either in the final count or was refused; none is lost and none
 * lands in a box that is gone. Some races here hold a lock from another
 * connection to prove who waits for whom.
 */
describe('Community life — a vote against the end of its poll', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let voters: { unitId: string; who: Who }[];
  let db: Client;

  const ROUNDS = 3;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    voters = await e.voters(s.c, 6);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const close = (id: string, action: 'close' | 'cancel' = 'close') =>
    e.http('post', `/community/polls/${id}/${action}`, s.manager.token);
  const row = (id: string) =>
    e.x.asManager(s.c, () =>
      e.x.prisma.tenant.poll.findUniqueOrThrow({
        where: { id },
        include: {
          options: { orderBy: { position: 'asc' } },
          ballotBox: true,
          participations: true,
        },
      }),
    );
  /** Holds a lock on the poll's row from another connection until settled. */
  async function holding(id: string, mode: 'FOR UPDATE' | 'FOR SHARE') {
    const held = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await held.connect();
    await held.query('BEGIN');
    await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      s.c.tenantId,
    ]);
    await held.query(`SELECT id FROM polls WHERE id = $1 ${mode}`, [id]);
    return held;
  }
  const settle = async (held: Client, sql?: string, params: unknown[] = []) => {
    if (sql) await held.query(sql, params);
    await held.query('COMMIT');
    await held.end();
  };
  const waitForLockWaiter = async () => {
    for (let i = 0; i < 100; i++) {
      const waiting = await db.query(
        `SELECT count(*) FROM pg_locks WHERE NOT granted`,
      );
      if (Number((waiting.rows[0] as { count: string }).count) > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the request never waited on the lock');
  };

  it('votes racing a close: every accepted vote is in the final count, every other was refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.poll(s.manager);
      const [yes] = await e.optionIds(s.manager, id);
      const [closed, ...votes] = await Promise.all([
        close(id),
        ...voters.map((v) => e.vote(v.who, id, [yes])),
      ]);
      expect(closed.status).toBe(204);
      const accepted = votes.filter((v) => v.status === 201).length;
      for (const v of votes.filter((x) => x.status !== 201))
        expect({ status: v.status, body: v.body as unknown }).toMatchObject({
          status: 409,
          body: { code: 'POLL_INVALID_STATE', params: { status: 'closed' } },
        });
      const after = await row(id);
      expect(after.ballotBox).toBeNull();
      expect(after.ballotSalt).toBeNull();
      expect(after.finalTurnout).toBe(accepted);
      expect(after.options.map((o) => o.finalCount)).toEqual([accepted, 0]);
      expect(after.participations).toHaveLength(accepted);
    }
  });

  it('votes racing a cancellation: none is counted, and none is left behind', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.poll(s.manager);
      const [yes] = await e.optionIds(s.manager, id);
      const [cancelled, ...votes] = await Promise.all([
        close(id, 'cancel'),
        ...voters.map((v) => e.vote(v.who, id, [yes])),
      ]);
      expect(cancelled.status).toBe(204);
      for (const v of votes) expect([201, 409]).toContain(v.status);
      const after = await row(id);
      expect(after.ballotBox).toBeNull();
      expect(after.ballotSalt).toBeNull();
      expect(after.finalTurnout).toBeNull();
      expect(after.participations).toEqual([]);
    }
  });

  it('a close waits for a vote in flight, then counts it', async () => {
    const id = await e.poll(s.manager);
    const [yes] = await e.optionIds(s.manager, id);
    await e.vote(voters[0].who, id, [yes]).expect(201);
    // Stands for a vote that holds the row and has not committed yet.
    const held = await holding(id, 'FOR SHARE');
    const closing = close(id).then((r) => r);
    await waitForLockWaiter();
    expect((await row(id)).closedAt).toBeNull();
    await settle(held);
    expect((await closing).status).toBe(204);
    const after = await row(id);
    expect(after.finalTurnout).toBe(1);
    expect(after.options.map((o) => o.finalCount)).toEqual([1, 0]);
  });

  it('a vote waits for a close in flight, then finds the poll closed', async () => {
    const id = await e.poll(s.manager);
    const [yes] = await e.optionIds(s.manager, id);
    // Stands for a close that holds the row; it commits the poll closed.
    const held = await holding(id, 'FOR UPDATE');
    const voting = e.vote(voters[0].who, id, [yes]).then((r) => r);
    await waitForLockWaiter();
    await settle(
      held,
      `UPDATE polls SET closed_at = now(), ballot_salt = NULL, final_turnout = 0
        WHERE id = $1`,
      [id],
    );
    const res = await voting;
    expect({ status: res.status, body: res.body as unknown }).toMatchObject({
      status: 409,
      body: { code: 'POLL_INVALID_STATE', params: { status: 'closed' } },
    });
  });

  it('a vote that waited past the closing time is refused by the clock, not by the sweep', async () => {
    const id = await e.poll(s.manager);
    const [yes] = await e.optionIds(s.manager, id);
    const held = await holding(id, 'FOR UPDATE');
    const voting = e.vote(voters[0].who, id, [yes]).then((r) => r);
    await waitForLockWaiter();
    // While the vote waited, the poll's time passed. Nothing swept it.
    await settle(
      held,
      `UPDATE polls SET opens_at = now() - interval '2 hours',
                        closes_at = now() - interval '1 second'
        WHERE id = $1`,
      [id],
    );
    const res = await voting;
    expect(res.status).toBe(409);
    const before = await row(id);
    expect(before.closedAt).toBeNull();
    expect(before.ballotBox!.ballots).toEqual({});
    expect(await e.sweep(POLL_CLOSE_SWEEP)).toBeGreaterThanOrEqual(1);
    expect((await row(id)).finalTurnout).toBe(0);
  });

  it('the sweep skips a poll a vote is still holding, and closes it on its next run', async () => {
    const id = await e.poll(s.manager);
    const [yes] = await e.optionIds(s.manager, id);
    await e.vote(voters[0].who, id, [yes]).expect(201);
    await e.x.asManager(s.c, () =>
      e.x.prisma.tenant.poll.update({
        where: { id },
        data: { opensAt: e.at(-2), closesAt: e.at(-0.01) },
      }),
    );
    const held = await holding(id, 'FOR SHARE');
    await e.sweep(POLL_CLOSE_SWEEP);
    expect((await row(id)).closedAt).toBeNull();
    await settle(held);
    await e.sweep(POLL_CLOSE_SWEEP);
    const after = await row(id);
    expect(after.closedAt).not.toBeNull();
    expect(after.finalTurnout).toBe(1);
  });

  it('two closes at once: one closes, the other is told it is closed; the counts are written once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await e.poll(s.manager);
      const [yes] = await e.optionIds(s.manager, id);
      await e.vote(voters[0].who, id, [yes]).expect(201);
      const results = await Promise.all([close(id), close(id)]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      const audit = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.auditLog.count({
          where: { action: 'poll.closed', targetId: id },
        }),
      );
      expect(audit).toBe(1);
      expect((await row(id)).participations).toHaveLength(1);
    }
  });
});
