import { Client } from 'pg';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';
import { required } from '../setup/test-env';

/**
 * ADR 0042: either side of a masked conversation may block the other.
 * From then on neither starts a conversation with the other nor sees the
 * other's posts, and the blocked side is told nothing. A block and a new
 * conversation between the same two take the same lock: they race here for
 * real, and against that lock held from outside.
 */
describe('Neighbours — blocks', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    await n.settings(s.c, s.manager, {
      maxOpenPosts: 50,
      maxNewConversationsPerDay: 100,
    });
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const ROUNDS = 3;
  type View = { id: string; open: boolean };
  /** Two residents of their own, so one test's block does not reach the next. */
  const pair = async () => ({
    ann: await n.owner(s.c, (await n.unit(s.c, 'P')).id),
    ben: await n.owner(s.c, (await n.unit(s.c, 'Q')).id),
  });
  const block = (who: Who, conversationId: string) =>
    n.http(
      'post',
      `/neighbour-conversations/${conversationId}/block`,
      who.token,
    );
  const view = async (who: Who, id: string) =>
    (
      await n
        .http('get', `/neighbour-conversations/${id}`, who.token)
        .expect(200)
    ).body as View;
  const board = async (who: Who) =>
    (await n.list<{ id: string }>('/neighbour-posts', who)).map((p) => p.id);
  const blocksBetween = (a: Who, b: Who) =>
    n.x.asManager(s.c, () =>
      n.x.prisma.tenant.neighbourBlock.count({
        where: {
          OR: [
            { blockerId: a.id, blockedId: b.id },
            { blockerId: b.id, blockedId: a.id },
          ],
        },
      }),
    );
  const openBetween = (a: Who, b: Who) =>
    n.x.asManager(s.c, () =>
      n.x.prisma.tenant.neighbourConversation.count({
        where: {
          closedAt: null,
          OR: [
            { authorId: a.id, responderId: b.id },
            { authorId: b.id, responderId: a.id },
          ],
        },
      }),
    );

  it('closes what is open between the two, on every post, and tells the blocked side nothing', async () => {
    const { ann, ben } = await pair();
    const one = await n.conversation(ben, await n.post(ann));
    const two = await n.conversation(
      ann,
      await n.post(ben, { kind: 'lend', body: 'A saw' }),
    );
    const told = (await n.notifications(s.c, ben.id)).length;
    await block(ann, one).expect(204);
    for (const id of [one, two])
      for (const who of [ann, ben])
        expect((await view(who, id)).open).toBe(false);
    expect((await n.notifications(s.c, ben.id)).length).toBe(told);
    // To Ben it reads as any conversation nothing more is written in: a
    // code and a message, with no reason and no params.
    const refused = (
      await n
        .http('post', `/neighbour-conversations/${one}/messages`, ben.token, {
          body: 'Hello?',
        })
        .expect(409)
    ).body as Record<string, unknown>;
    expect(refused).toMatchObject({ code: 'NEIGHBOUR_CONVERSATION_CLOSED' });
    expect(Object.keys(refused).sort()).toEqual([
      'code',
      'message',
      'path',
      'requestId',
      'statusCode',
      'timestamp',
    ]);
    expect(JSON.stringify(refused)).not.toMatch(/block/i);
    const text = JSON.stringify(await view(ben, one));
    expect(text).not.toMatch(/block/i);
    expect(text).not.toContain('closeReason');
  });

  it('neither sees the other’s posts any more, whichever of them blocked; everyone else still does', async () => {
    const { ann, ben } = await pair();
    const anns = await n.post(ann);
    const bens = await n.post(ben);
    await block(ben, await n.conversation(ben, anns)).expect(204);
    const later = await n.post(ann, { kind: 'lend', body: 'A hose' });
    expect(
      (await board(ben)).filter((id) => [anns, later].includes(id)),
    ).toEqual([]);
    expect(await board(ann)).not.toContain(bens);
    expect(await board(s.alice)).toEqual(
      expect.arrayContaining([anns, bens, later]),
    );
    // By its id it is the ordinary not-found, as for a post that is gone.
    for (const [who, post] of [
      [ben, later],
      [ann, bens],
    ] as const) {
      const res = await n.http('get', `/neighbour-posts/${post}`, who.token);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NEIGHBOUR_POST_NOT_FOUND' });
      expect((await n.contact(who, post).expect(404)).body).toMatchObject({
        code: 'NEIGHBOUR_POST_NOT_FOUND',
      });
      await n
        .http('post', `/neighbour-posts/${post}/claims`, who.token, {})
        .expect(404);
    }
    // Their own posts stay theirs to read.
    await n.http('get', `/neighbour-posts/${anns}`, ann.token).expect(200);
  });

  it('the blocker’s list shows a building and a date, never who; unblocking lets them meet again', async () => {
    const { ann, ben } = await pair();
    const post = await n.post(ann);
    const id = await n.conversation(ben, post);
    await block(ben, id).expect(204);
    // Blocking again changes nothing.
    await block(ben, id).expect(204);
    const mine = await n.list<{ id: string; building: string | null }>(
      '/neighbour-blocks',
      ben,
    );
    expect(mine).toEqual([
      {
        id: expect.any(String) as string,
        building: 'P',
        createdAt: expect.any(String) as string,
      },
    ]);
    expect(JSON.stringify(mine)).not.toContain(ann.id);
    // The blocked side has no list entry and no way to undo it.
    expect(await n.list('/neighbour-blocks', ann)).toEqual([]);
    expect(
      (
        await n
          .http('delete', `/neighbour-blocks/${mine[0].id}`, ann.token)
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'NEIGHBOUR_BLOCK_NOT_FOUND' });
    await n
      .http('delete', `/neighbour-blocks/${mine[0].id}`, ben.token)
      .expect(204);
    await n
      .http('delete', `/neighbour-blocks/${mine[0].id}`, ben.token)
      .expect(404);
    expect(await blocksBetween(ann, ben)).toBe(0);
    // What it closed stays closed; a new post is a new start.
    expect((await view(ben, id)).open).toBe(false);
    const again = await n.post(ann, { kind: 'lend', body: 'A bike pump' });
    expect(await board(ben)).toContain(again);
    await n.conversation(ben, again);
  });

  it('each may block the other: one block each way, and both must be undone', async () => {
    const { ann, ben } = await pair();
    const id = await n.conversation(ben, await n.post(ann));
    await block(ann, id).expect(204);
    await block(ben, id).expect(204);
    expect(await blocksBetween(ann, ben)).toBe(2);
    const [anns] = await n.list<{ id: string }>('/neighbour-blocks', ann);
    await n
      .http('delete', `/neighbour-blocks/${anns.id}`, ann.token)
      .expect(204);
    const post = await n.post(ann, { kind: 'lend', body: 'A lamp' });
    expect(await board(ben)).not.toContain(post);
    await n.contact(ben, post).expect(404);
  });

  it('a block and a new conversation between the two, at once: never an open conversation across a block', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { ann, ben } = await pair();
      const first = await n.conversation(ben, await n.post(ann));
      const next = await n.post(ann, { kind: 'lend', body: 'A drill' });
      const [blocked, started] = await Promise.all([
        block(ann, first),
        n.contact(ben, next),
      ]);
      expect(blocked.status).toBe(204);
      // Before the block: started, and then closed by it. After: not found.
      expect([201, 404]).toContain(started.status);
      expect(await blocksBetween(ann, ben)).toBe(1);
      expect(await openBetween(ann, ben)).toBe(0);
      if (started.status === 201)
        expect(
          (await view(ben, (started.body as { id: string }).id)).open,
        ).toBe(false);
      else
        expect(started.body).toMatchObject({
          code: 'NEIGHBOUR_POST_NOT_FOUND',
        });
    }
  });

  it('both blocking each other at once: two blocks, nothing left open', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { ann, ben } = await pair();
      const id = await n.conversation(ben, await n.post(ann));
      const results = await Promise.all([block(ann, id), block(ben, id)]);
      expect(results.map((r) => r.status)).toEqual([204, 204]);
      expect(await blocksBetween(ann, ben)).toBe(2);
      expect(await openBetween(ann, ben)).toBe(0);
    }
  });

  it('one side blocking twice at once: one block', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { ann, ben } = await pair();
      const id = await n.conversation(ben, await n.post(ann));
      const results = await Promise.all([block(ann, id), block(ann, id)]);
      expect(results.map((r) => r.status)).toEqual([204, 204]);
      expect(await blocksBetween(ann, ben)).toBe(1);
    }
  });

  it('a message and a block at once: written before it, or refused after it', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { ann, ben } = await pair();
      const id = await n.conversation(ben, await n.post(ann));
      const [written, blocked] = await Promise.all([
        n.http('post', `/neighbour-conversations/${id}/messages`, ben.token, {
          body: 'One more',
        }),
        block(ann, id),
      ]);
      expect(blocked.status).toBe(204);
      expect([201, 409]).toContain(written.status);
      const messages = await n.list(
        `/neighbour-conversations/${id}/messages`,
        ann,
      );
      expect(messages).toHaveLength(written.status === 201 ? 2 : 1);
      expect((await view(ann, id)).open).toBe(false);
    }
  });

  describe('with the pair held', () => {
    /** Holds the advisory lock a block and a new conversation both take. */
    async function holdingPair(a: Who, b: Who) {
      const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      const held = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await held.connect();
      await held.query('BEGIN');
      await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      await held.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `neighbour-pair:${s.c.tenantId}:${low}:${high}`,
      ]);
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
          `SELECT count(*) FROM pg_locks WHERE NOT granted AND locktype = 'advisory'`,
        );
        if (Number((waiting.rows[0] as { count: string }).count) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the request never waited on the pair');
    };

    it('a new conversation waits for it, then finds the block written meanwhile and is refused as not found', async () => {
      const { ann, ben } = await pair();
      const first = await n.conversation(ben, await n.post(ann));
      const next = await n.post(ann, { kind: 'lend', body: 'A drill' });
      const held = await holdingPair(ann, ben);
      const waiting = n.contact(ben, next).then((r) => r);
      await waitForLockWaiter();
      await settle(
        held,
        `INSERT INTO neighbour_blocks (id, tenant_id, blocker_account_id, blocked_account_id, conversation_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [s.c.tenantId, ann.id, ben.id, first],
      );
      const res = await waiting;
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NEIGHBOUR_POST_NOT_FOUND' });
      expect(
        await n.x.asManager(s.c, () =>
          n.x.prisma.tenant.neighbourConversation.count({
            where: { postId: next },
          }),
        ),
      ).toBe(0);
    });

    it('a block waits for it, then closes the conversation started meanwhile', async () => {
      const { ann, ben } = await pair();
      const first = await n.conversation(ben, await n.post(ann));
      const next = await n.post(ann, { kind: 'lend', body: 'A drill' });
      const held = await holdingPair(ann, ben);
      const waiting = block(ann, first).then((r) => r);
      await waitForLockWaiter();
      const started =
        '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0');
      await settle(
        held,
        `INSERT INTO neighbour_conversations
           (id, tenant_id, post_id, author_account_id, responder_account_id, last_message_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [started, s.c.tenantId, next, ann.id, ben.id],
      );
      expect((await waiting).status).toBe(204);
      expect(await openBetween(ann, ben)).toBe(0);
      const row = await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.neighbourConversation.findUniqueOrThrow({
          where: { id: started },
        }),
      );
      expect(row.closeReason).toBe('blocked');
    });

    it('a new conversation waits for it, and starts when the holder leaves no block', async () => {
      const { ann, ben } = await pair();
      const post = await n.post(ann);
      const held = await holdingPair(ann, ben);
      const waiting = n.contact(ben, post).then((r) => r);
      await waitForLockWaiter();
      await settle(held);
      expect((await waiting).status).toBe(201);
    });
  });
});
