import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: masked contact. A conversation exists only on a board post,
 * between its author and one responder; each is "a resident of building X"
 * to the other; nobody else reads it, the staff included.
 */
describe('Neighbours — masked conversations', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let audit: ReturnType<typeof auditReaders>;
  let carol: Who;
  let names: Record<string, string>;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    audit = auditReaders(h);
    carol = await n.owner(s.c, (await n.unit(s.c, 'C')).id);
    await n.settings(s.c, s.manager, {
      maxOpenPosts: 50,
      maxNewConversationsPerDay: 100,
    });
    const accounts = await n.x.asManager(s.c, () =>
      n.x.prisma.tenant.account.findMany({
        where: { id: { in: [s.alice.id, s.bob.id, carol.id] } },
      }),
    );
    names = Object.fromEntries(accounts.map((a) => [a.id, a.fullName!]));
  }, 180_000);

  afterAll(() => h.close());

  type Conversation = Record<string, unknown> & {
    id: string;
    side: string;
    open: boolean;
    other: { building: string | null; firstName: string | null };
  };
  type Message = { id: string; mine: boolean; body: string | null };
  const get = (who: Who, id: string) =>
    n.http('get', `/neighbour-conversations/${id}`, who.token);
  const thread = (who: Who, id: string) =>
    n.list<Message>(`/neighbour-conversations/${id}/messages`, who);
  const write = (who: Who, id: string, body: string) =>
    n.http('post', `/neighbour-conversations/${id}/messages`, who.token, {
      body,
    });

  describe('starting one', () => {
    it('a resident writes to whoever posted; both read it, each as a building to the other', async () => {
      const post = await n.post(s.alice, { kind: 'lend', body: 'A ladder' });
      const res = await n.contact(s.bob, post, 'Is it still free?').expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.body as object).sort()).toEqual([
        'createdAt',
        'id',
      ]);
      const id = (res.body as { id: string }).id;
      expect((await get(s.bob, id).expect(200)).body).toMatchObject({
        id,
        post: { id: post, kind: 'lend', state: 'open' },
        side: 'responder',
        open: true,
        other: { building: 'A', firstName: null },
        namesRevealed: false,
        iAgreed: false,
        theyAgreed: false,
      });
      expect((await get(s.alice, id).expect(200)).body).toMatchObject({
        side: 'author',
        other: { building: 'B', firstName: null },
      });
      expect(await thread(s.alice, id)).toMatchObject([
        { mine: false, body: 'Is it still free?' },
      ]);
      expect(await thread(s.bob, id)).toMatchObject([{ mine: true }]);
      expect(
        (await n.notifications(s.c, s.alice.id)).filter(
          (x) => x.targetId === id,
        ),
      ).toMatchObject([
        {
          kind: 'neighbour_conversation.started',
          targetType: 'neighbour_conversation',
          params: { postKind: 'lend' },
        },
      ]);
    });

    it('nothing either side reads names the other: no id, no name, no unit', async () => {
      const post = await n.post(s.alice, { body: 'A scarf' });
      const id = await n.conversation(s.bob, post);
      await write(s.alice, id, 'Yes, come by').expect(201);
      const seenBy = async (who: Who) =>
        JSON.stringify([
          (await get(who, id).expect(200)).body,
          await n.list('/neighbour-conversations', who),
          await thread(who, id),
          await n.notifications(s.c, who.id),
        ]);
      const bob = await seenBy(s.bob);
      for (const secret of [
        s.alice.id,
        names[s.alice.id],
        names[s.alice.id].split(' ')[0],
        s.homeA.id,
        s.homeA.code,
      ])
        expect(bob).not.toContain(secret);
      const alice = await seenBy(s.alice);
      for (const secret of [
        s.bob.id,
        names[s.bob.id],
        names[s.bob.id].split(' ')[0],
        s.homeB.id,
        s.homeB.code,
      ])
        expect(alice).not.toContain(secret);
      // A message has no sender at all: it is the caller's, or it is not.
      for (const m of await thread(s.bob, id))
        expect(Object.keys(m).sort()).toEqual([
          'body',
          'createdAt',
          'erased',
          'id',
          'mine',
        ]);
    });

    it('one conversation per post and responder; several responders each have their own', async () => {
      const post = await n.post(s.alice, { kind: 'borrow', body: 'A drill' });
      const bobs = await n.conversation(s.bob, post);
      expect((await n.contact(s.bob, post).expect(409)).body).toMatchObject({
        code: 'NEIGHBOUR_CONVERSATION_EXISTS',
        params: { conversationId: bobs },
      });
      const carols = await n.conversation(carol, post);
      expect(carols).not.toBe(bobs);
      expect(
        (await n.list<Conversation>('/neighbour-conversations', s.alice))
          .map((c) => c.id)
          .filter((id) => [bobs, carols].includes(id))
          .sort(),
      ).toEqual([bobs, carols].sort());
      // Each responder reads their own, never the other's.
      await get(carol, bobs).expect(404);
      await get(s.bob, carols).expect(404);
    });

    it('never about one’s own post, the management’s, or one off its board', async () => {
      const own = await n.post(s.bob);
      expect((await n.contact(s.bob, own).expect(409)).body).toMatchObject({
        code: 'NEIGHBOUR_POST_NO_CONTACT',
      });
      const staffs = await n.staffPost(s.handler);
      expect((await n.contact(s.bob, staffs).expect(409)).body).toMatchObject({
        code: 'NEIGHBOUR_POST_NO_CONTACT',
      });
      const gone = await n.post(s.alice);
      await n.expire(s.c, gone);
      expect((await n.contact(s.bob, gone).expect(404)).body).toMatchObject({
        code: 'NEIGHBOUR_POST_NOT_FOUND',
      });
      const other = await n.setUp();
      await n.contact(s.bob, await n.post(other.alice)).expect(404);
    });

    it('the same Idempotency-Key starts one', async () => {
      const post = await n.post(s.alice);
      const start = () =>
        n.http(
          'post',
          `/neighbour-posts/${post}/conversations`,
          carol.token,
          { body: 'Hello' },
          { 'Idempotency-Key': `conversation-${post}` },
        );
      const first = await start().expect(201);
      const again = await start().expect(201);
      expect(again.body).toEqual(first.body);
      expect(again.headers['idempotent-replayed']).toBe('true');
    });

    it('is audited by the post, never by who talks to whom or what they say', async () => {
      const post = await n.post(s.alice);
      const res = await n
        .contact(s.bob, post, 'AUDIT-FREE-TEXT hello')
        .expect(201);
      const id = (res.body as { id: string }).id;
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_conversation.started',
        targetId: id,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ postId: post, postKind: 'found' });
      const text = JSON.stringify(rows[0]);
      expect(text).not.toContain('AUDIT-FREE-TEXT');
      // The actor is the one who wrote; the other side is nowhere in the row.
      expect(text).not.toContain(s.alice.id);
    });
  });

  describe('a day’s new conversations', () => {
    it('an account starts as many as the compound allows in 24 hours, and not one more', async () => {
      const c = await n.setUp();
      await n.settings(c.c, c.manager, { maxNewConversationsPerDay: 2 });
      const posts = [];
      for (let i = 0; i < 3; i++) posts.push(await n.post(c.alice));
      await n.conversation(c.bob, posts[0]);
      await n.conversation(c.bob, posts[1]);
      expect((await n.contact(c.bob, posts[2]).expect(409)).body).toMatchObject(
        {
          code: 'NEIGHBOUR_CONVERSATION_LIMIT_REACHED',
          params: { max: 2 },
        },
      );
      // Writing in one already started is not starting one.
      const [first] = await n.list<Conversation>(
        '/neighbour-conversations',
        c.bob,
      );
      await write(c.bob, first.id, 'Still here').expect(201);
      // Being written to costs the author nothing.
      await n.conversation(c.alice, await n.post(c.bob));
    });

    it('three starts at once with one left: one conversation', async () => {
      const c = await n.setUp();
      await n.settings(c.c, c.manager, { maxNewConversationsPerDay: 1 });
      const posts = [];
      for (let i = 0; i < 3; i++) posts.push(await n.post(c.alice));
      const results = await Promise.all(posts.map((p) => n.contact(c.bob, p)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(
        await n.x.asManager(c.c, () =>
          n.x.prisma.tenant.neighbourConversation.count({
            where: { responderId: c.bob.id },
          }),
        ),
      ).toBe(1);
    });
  });

  describe('who reads it', () => {
    let post: string;
    let id: string;
    beforeAll(async () => {
      post = await n.post(s.alice, { kind: 'lend', body: 'A tent' });
      id = await n.conversation(s.bob, post);
    });

    it('its two sides, and nobody else: not a neighbour, not their family', async () => {
      const family = await n.family(s.c, s.homeA.id, s.alice);
      for (const who of [carol, family]) {
        expect((await get(who, id).expect(404)).body).toMatchObject({
          code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
        });
        await n
          .http('get', `/neighbour-conversations/${id}/messages`, who.token)
          .expect(404);
        await write(who, id, 'Me too').expect(404);
        for (const action of ['reveal', 'block'])
          await n
            .http('post', `/neighbour-conversations/${id}/${action}`, who.token)
            .expect(404);
        await n
          .http('post', `/neighbour-conversations/${id}/report`, who.token, {
            reasonCode: 'spam',
          })
          .expect(404);
        expect(
          (await n.list<Conversation>('/neighbour-conversations', who)).map(
            (c) => c.id,
          ),
        ).not.toContain(id);
      }
    });

    it('the staff have no route to a conversation nobody reported', async () => {
      for (const who of [s.handler, s.manager]) {
        // The residents' routes are not theirs.
        await get(who, id).expect(403);
        await n
          .http('get', `/neighbour-conversations/${id}/messages`, who.token)
          .expect(403);
        await n.http('get', '/neighbour-conversations', who.token).expect(403);
        // The desk shows the post, and nothing of who wrote about it.
        const desk = JSON.stringify([
          (
            await n
              .http('get', `/neighbours/posts/${post}`, who.token)
              .expect(200)
          ).body,
          await n.list('/neighbours/posts?board=lending', who),
          await n.list('/neighbours/reports', who),
        ]);
        expect(desk).not.toContain(id);
        expect(desk).not.toContain(s.bob.id);
        // No case, no reading: the id of a conversation opens nothing.
        await n.http('get', `/neighbours/reports/${id}`, who.token).expect(404);
        await n
          .http('get', `/neighbours/reports/${id}/messages`, who.token)
          .expect(404);
      }
    });
  });

  describe('when nothing more is written', () => {
    it('its post closed, removed or off its board: both still read it, neither writes', async () => {
      const endings: ((post: string) => Promise<unknown>)[] = [
        (post) =>
          n
            .http('post', `/neighbour-posts/${post}/close`, s.alice.token, {
              reasonCode: 'resolved',
            })
            .expect(204),
        (post) =>
          n
            .http('post', `/neighbours/posts/${post}/remove`, s.handler.token, {
              reasonCode: 'duplicate',
            })
            .expect(204),
        (post) => n.expire(s.c, post),
      ];
      for (const end of endings) {
        const post = await n.post(s.alice, { kind: 'lend', body: 'A saw' });
        const id = await n.conversation(s.bob, post);
        await end(post);
        for (const who of [s.alice, s.bob]) {
          expect((await get(who, id).expect(200)).body).toMatchObject({
            open: false,
          });
          expect(await thread(who, id)).toHaveLength(1);
          expect(
            (await write(who, id, 'Hello?').expect(409)).body,
          ).toMatchObject({ code: 'NEIGHBOUR_CONVERSATION_CLOSED' });
          await n
            .http('post', `/neighbour-conversations/${id}/reveal`, who.token)
            .expect(409);
        }
      }
    });

    it('a message is one to two thousand characters of text', async () => {
      const post = await n.post(s.alice);
      const id = await n.conversation(s.bob, post);
      for (const body of ['   ', 'x'.repeat(2001)])
        expect(
          (
            (await write(s.bob, id, body).expect(400)).body as {
              fields: unknown[];
            }
          ).fields,
        ).toEqual([
          {
            field: 'body',
            code: 'INVALID_LENGTH',
            params: { min: 1, max: 2000 },
          },
        ]);
      await write(s.bob, id, 'x'.repeat(2000)).expect(201);
    });
  });
});
