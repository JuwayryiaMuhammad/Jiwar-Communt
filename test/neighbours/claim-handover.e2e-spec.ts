import { Client } from 'pg';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';
import { required } from '../setup/test-env';

/**
 * The races of a found item (ADR 0042), run for real: a claim against a
 * handover, two handovers, a withdrawal against a handover. Every write
 * takes the post's row, so each outcome is one of the allowed ones and the
 * post, its claims, its one handover and the audit trail agree. Where a
 * race hinges on that lock it is held from another connection.
 */
describe('Neighbours — a claim against a handover', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let carol: Who;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    carol = await n.owner(s.c, (await n.unit(s.c, 'C')).id);
    await n.settings(s.c, s.manager, { maxOpenPosts: 50 });
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const ROUNDS = 3;
  const state = (postId: string) =>
    n.x.asManager(s.c, async () => ({
      post: await n.x.prisma.tenant.neighbourPost.findUniqueOrThrow({
        where: { id: postId },
      }),
      claims: await n.x.prisma.tenant.neighbourItemClaim.findMany({
        where: { postId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      handovers: await n.x.prisma.tenant.neighbourItemHandover.findMany({
        where: { postId },
      }),
      audits: await n.x.prisma.tenant.auditLog.count({
        where: { action: 'neighbour_item.handed_over', targetId: postId },
      }),
    }));
  const handOver = (postId: string, body: object, who: Who = s.handler) =>
    n.http('post', `/neighbours/posts/${postId}/handover`, who.token, body);
  const claim = (who: Who, postId: string) =>
    n.http('post', `/neighbour-posts/${postId}/claims`, who.token, {});

  /** No claim is left pending on a closed post, and it was handed over once. */
  const consistent = async (postId: string) => {
    const now = await state(postId);
    expect(now.post.status).toBe('closed');
    expect(now.post.closeReason).toBe('handed_over');
    expect(now.handovers).toHaveLength(1);
    expect(now.audits).toBe(1);
    expect(now.claims.filter((c) => c.status === 'pending')).toEqual([]);
    expect(
      now.claims.filter((c) => c.status === 'handed_over').length,
    ).toBeLessThanOrEqual(1);
    return now;
  };

  it('a claim and a handover at once: the claim is declined with the rest, or refused; never left pending', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const post = await n.post(s.alice);
      const bobs = await n.claim(s.bob, post);
      const [late, handed] = await Promise.all([
        claim(carol, post),
        handOver(post, { claimId: bobs }),
      ]);
      expect(handed.status).toBe(204);
      // First: written, then declined by the handover. Second: the post
      // was closed (and so off its board) when it looked.
      expect([201, 404, 409]).toContain(late.status);
      const now = await consistent(post);
      const carols = now.claims.find((c) => c.claimantId === carol.id);
      if (late.status === 201)
        expect(carols).toMatchObject({
          status: 'declined',
          declineReason: 'handed_to_another',
        });
      else expect(carols).toBeUndefined();
      expect(now.handovers[0]).toMatchObject({
        claimId: bobs,
        recipientId: s.bob.id,
      });
    }
  });

  it('two handovers at once, to two claimants: one item goes to one of them', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const post = await n.post(s.alice);
      const bobs = await n.claim(s.bob, post);
      const carols = await n.claim(carol, post);
      const results = await Promise.all([
        handOver(post, { claimId: bobs }),
        handOver(post, { claimId: carols }, s.manager),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body).toMatchObject({
        code: 'NEIGHBOUR_POST_NOT_OPEN',
        params: { state: 'closed' },
      });
      const now = await consistent(post);
      const winner = results[0].status === 204 ? bobs : carols;
      expect(now.handovers[0].claimId).toBe(winner);
      expect(
        Object.fromEntries(now.claims.map((c) => [c.id, c.status])),
      ).toEqual({
        [winner]: 'handed_over',
        [winner === bobs ? carols : bobs]: 'declined',
      });
    }
  });

  it('a walk-in and a claimant at once: one handover', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const post = await n.post(s.alice);
      const bobs = await n.claim(s.bob, post);
      const results = await Promise.all([
        handOver(post, { claimId: bobs }),
        handOver(post, { recipientAccountId: carol.id }, s.manager),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      const now = await consistent(post);
      expect(now.handovers[0].recipientId).toBe(
        results[0].status === 204 ? s.bob.id : carol.id,
      );
    }
  });

  it('a withdrawal and the handover of that same claim at once: handed over, or withdrawn and the handover refused', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const post = await n.post(s.alice);
      const bobs = await n.claim(s.bob, post);
      const [withdrawn, handed] = await Promise.all([
        n.http('post', `/neighbour-claims/${bobs}/withdraw`, s.bob.token),
        handOver(post, { claimId: bobs }),
      ]);
      expect([withdrawn.status, handed.status].sort()).toEqual([204, 409]);
      const now = await state(post);
      if (handed.status === 204) {
        expect(withdrawn.body).toMatchObject({
          code: 'NEIGHBOUR_CLAIM_INVALID_STATE',
          params: { status: 'handed_over' },
        });
        expect(now.claims[0].status).toBe('handed_over');
        expect(now.handovers).toHaveLength(1);
      } else {
        expect(handed.body).toMatchObject({
          code: 'NEIGHBOUR_CLAIM_INVALID_STATE',
          params: { status: 'withdrawn' },
        });
        expect(now.claims[0].status).toBe('withdrawn');
        expect(now.handovers).toEqual([]);
        expect(now.post.status).toBe('open');
      }
    }
  });

  it('the same person claiming twice at once: one pending claim', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const post = await n.post(s.alice);
      const results = await Promise.all([
        claim(s.bob, post),
        claim(s.bob, post),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        (await state(post)).claims.filter((c) => c.status === 'pending'),
      ).toHaveLength(1);
    }
  });

  describe('with the post held', () => {
    async function holding(postId: string) {
      const held = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await held.connect();
      await held.query('BEGIN');
      await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      await held.query(
        `SELECT id FROM neighbour_posts WHERE id = $1 FOR UPDATE`,
        [postId],
      );
      return held;
    }
    const settle = async (
      held: Client,
      sql?: string,
      params: unknown[] = [],
    ) => {
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
      throw new Error('the request never waited on the post');
    };
    const closeIt = `UPDATE neighbour_posts
        SET status = 'closed', closed_at = now(), close_reason = 'handed_over'
      WHERE id = $1`;

    it('a claim waits for the post, then finds it closed and is refused', async () => {
      const post = await n.post(s.alice);
      const held = await holding(post);
      const waiting = claim(s.bob, post).then((r) => r);
      await waitForLockWaiter();
      await settle(held, closeIt, [post]);
      const res = await waiting;
      // Closed means off its board: for the claimant it is not there.
      expect(res.status).toBe(404);
      expect((await state(post)).claims).toEqual([]);
    });

    it('a handover waits for the post, then finds it closed and is refused', async () => {
      const post = await n.post(s.alice);
      const bobs = await n.claim(s.bob, post);
      const held = await holding(post);
      const waiting = handOver(post, { claimId: bobs }).then((r) => r);
      await waitForLockWaiter();
      await settle(held, closeIt, [post]);
      const res = await waiting;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'NEIGHBOUR_POST_NOT_OPEN',
        params: { state: 'closed' },
      });
      expect((await state(post)).handovers).toEqual([]);
    });

    it('a claim waits for the post, and is written when the holder leaves it open', async () => {
      const post = await n.post(s.alice);
      const held = await holding(post);
      const waiting = claim(s.bob, post).then((r) => r);
      await waitForLockWaiter();
      const before = await held.query(`SELECT clock_timestamp() AS at`);
      await settle(held);
      const res = await waiting;
      expect(res.status).toBe(201);
      const created = new Date((res.body as { createdAt: string }).createdAt);
      expect(created.getTime()).toBeGreaterThanOrEqual(
        new Date((before.rows[0] as { at: Date }).at).getTime() - 1,
      );
    });
  });
});
