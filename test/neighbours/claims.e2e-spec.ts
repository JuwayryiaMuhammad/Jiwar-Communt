import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: a found item is held at the management office. A resident
 * claims it; the staff decline or record the handover — to whom, by whom
 * and when — which closes the post and declines whoever else was waiting.
 */
describe('Neighbours — claims on found items and the handover', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let audit: ReturnType<typeof auditReaders>;
  let carol: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    audit = auditReaders(h);
    carol = await n.owner(s.c, (await n.unit(s.c, 'C')).id);
    await n.settings(s.c, s.manager, { maxOpenPosts: 50 });
  }, 180_000);

  afterAll(() => h.close());

  type Claim = Record<string, unknown> & { id: string; status: string };
  const claimsOf = (postId: string, who: Who = s.handler) =>
    n.list<Claim>(`/neighbours/posts/${postId}/claims`, who);
  const handOver = (postId: string, body: object, who: Who = s.handler) =>
    n.http('post', `/neighbours/posts/${postId}/handover`, who.token, body);
  const staffPost = async (id: string) =>
    (
      await n
        .http('get', `/neighbours/posts/${id}`, s.handler.token)
        .expect(200)
    ).body as Record<string, unknown>;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;

  describe('claiming', () => {
    it('a resident claims a found item, with a note for the staff alone', async () => {
      const post = await n.post(s.alice);
      const res = await n
        .http('post', `/neighbour-posts/${post}/claims`, s.bob.token, {
          note: '  CLAIM-NOTE red tag, three keys  ',
        })
        .expect(201);
      // No note in the answer: a stored replay holds no free text.
      expect(Object.keys(res.body as object).sort()).toEqual([
        'createdAt',
        'id',
        'status',
      ]);
      const id = (res.body as { id: string }).id;
      expect(await claimsOf(post)).toMatchObject([
        {
          id,
          status: 'pending',
          note: 'CLAIM-NOTE red tag, three keys',
          claimant: { id: s.bob.id, fullName: expect.any(String) as string },
        },
      ]);
      expect(await n.list<Claim>('/neighbour-claims', s.bob)).toMatchObject([
        { id, postId: post, status: 'pending' },
      ]);
      // The finder sees neither the claim nor who made it.
      const finder = JSON.stringify([
        (await n.http('get', `/neighbour-posts/${post}`, s.alice.token)).body,
        await n.list('/neighbour-claims', s.alice),
      ]);
      expect(finder).not.toContain('CLAIM-NOTE');
      expect(finder).not.toContain(s.bob.id);
      expect(finder).not.toContain(id);
      // The claimant's own view of the post says they claimed it.
      expect(
        (await n.http('get', `/neighbour-posts/${post}`, s.bob.token)).body,
      ).toMatchObject({ myClaim: { id, status: 'pending' } });
      expect(
        (await n.notifications(s.c, s.handler.id)).filter(
          (x) => x.targetId === post,
        ),
      ).toMatchObject([
        { kind: 'neighbour_item.claimed', params: { postKind: 'found' } },
      ]);
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_claim.created',
        targetId: id,
      });
      expect(rows[0].metadata).toEqual({ postId: post });
      expect(JSON.stringify(rows)).not.toContain('CLAIM-NOTE');
    });

    it('once: a second pending claim is refused; a withdrawn one may be made again', async () => {
      const post = await n.post(s.alice);
      const first = await n.claim(s.bob, post);
      expect(
        (
          await n
            .http('post', `/neighbour-posts/${post}/claims`, s.bob.token, {})
            .expect(409)
        ).body,
      ).toMatchObject({ code: 'NEIGHBOUR_CLAIM_EXISTS' });
      await n
        .http('post', `/neighbour-claims/${first}/withdraw`, s.bob.token)
        .expect(204);
      expect(
        (
          await n
            .http('post', `/neighbour-claims/${first}/withdraw`, s.bob.token)
            .expect(409)
        ).body,
      ).toMatchObject({
        code: 'NEIGHBOUR_CLAIM_INVALID_STATE',
        params: { status: 'withdrawn' },
      });
      const second = await n.claim(s.bob, post);
      expect(second).not.toBe(first);
      // Several people may claim the same item.
      await n.claim(carol, post);
      expect((await claimsOf(post)).map((c) => c.status)).toEqual([
        'withdrawn',
        'pending',
        'pending',
      ]);
    });

    it('only a found item, never one’s own, never one off its board', async () => {
      const lost = await n.post(s.alice, { kind: 'lost', body: 'A cat' });
      const lend = await n.post(s.alice, { kind: 'lend', body: 'A ladder' });
      const own = await n.post(s.bob);
      for (const post of [lost, lend, own])
        expect(
          (
            await n
              .http('post', `/neighbour-posts/${post}/claims`, s.bob.token, {})
              .expect(409)
          ).body,
        ).toMatchObject({ code: 'NEIGHBOUR_POST_NOT_CLAIMABLE' });
      const gone = await n.post(s.alice);
      await n.expire(s.c, gone);
      await n
        .http('post', `/neighbour-posts/${gone}/claims`, s.bob.token, {})
        .expect(404);
    });

    it('a claim is its claimant’s: nobody else withdraws it, and a resident reads no desk', async () => {
      const post = await n.post(s.alice);
      const id = await n.claim(s.bob, post);
      for (const who of [s.alice, carol])
        expect(
          (
            await n
              .http('post', `/neighbour-claims/${id}/withdraw`, who.token)
              .expect(404)
          ).body,
        ).toMatchObject({ code: 'NEIGHBOUR_CLAIM_NOT_FOUND' });
      for (const who of [s.alice, s.bob]) {
        await n
          .http('get', `/neighbours/posts/${post}/claims`, who.token)
          .expect(403);
        await handOver(post, { claimId: id }, who).expect(403);
        await n
          .http('post', `/neighbours/claims/${id}/decline`, who.token, {
            reasonCode: 'not_the_owner',
          })
          .expect(403);
      }
    });
  });

  describe('the desk', () => {
    it('declines a claim with a reason from the list; the claimant is told', async () => {
      const post = await n.post(s.alice);
      const id = await n.claim(s.bob, post);
      const decline = (reasonCode: string) =>
        n.http('post', `/neighbours/claims/${id}/decline`, s.handler.token, {
          reasonCode,
        });
      expect(fields(await decline('handed_to_another').expect(400))).toEqual([
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: { allowed: ['not_the_owner', 'insufficient_proof'] },
        },
      ]);
      await decline('insufficient_proof').expect(204);
      await decline('not_the_owner').expect(409);
      expect(await n.list<Claim>('/neighbour-claims', s.bob)).toMatchObject([
        { id, status: 'declined', declineReason: 'insufficient_proof' },
      ]);
      expect(
        await n.notifications(s.c, s.bob.id, 'neighbour_claim.declined'),
      ).toMatchObject([{ targetId: post, params: { postKind: 'found' } }]);
      // The post is still on its board, for whoever it does belong to.
      await n.claim(carol, post);
    });

    it('hands the item to a claimant: recorded once, the post closes, the others are declined and told', async () => {
      const post = await n.post(s.alice);
      const bobs = await n.claim(s.bob, post);
      const carols = await n.claim(carol, post);
      await handOver(post, { claimId: bobs }).expect(204);
      expect(await staffPost(post)).toMatchObject({
        state: 'closed',
        closeReason: 'handed_over',
        pendingClaims: 0,
        handover: {
          claimId: bobs,
          recipient: { id: s.bob.id },
          handedBy: { id: s.handler.id },
          handedAt: expect.any(String) as string,
        },
      });
      const claims = await claimsOf(post);
      expect(
        Object.fromEntries(
          claims.map((c) => [c.id, [c.status, c.declineReason]]),
        ),
      ).toEqual({
        [bobs]: ['handed_over', null],
        [carols]: ['declined', 'handed_to_another'],
      });
      expect(
        (await n.notifications(s.c, s.bob.id)).filter(
          (x) => x.targetId === post,
        ),
      ).toMatchObject([{ kind: 'neighbour_item.handed_over' }]);
      expect(
        (await n.notifications(s.c, carol.id)).filter(
          (x) => x.targetId === post,
        ),
      ).toMatchObject([{ kind: 'neighbour_claim.declined' }]);
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_item.handed_over',
        targetId: post,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({
        kind: 'found',
        reasonCode: 'handed_over',
        claimId: bobs,
        recipientAccountId: s.bob.id,
      });
      // Once: neither again, nor to another.
      expect(
        (await handOver(post, { claimId: carols }).expect(409)).body,
      ).toMatchObject({
        code: 'NEIGHBOUR_POST_NOT_OPEN',
        params: { state: 'closed' },
      });
      // Off its board for everyone but its author.
      await n.http('get', `/neighbour-posts/${post}`, carol.token).expect(404);
    });

    it('hands the item to a resident who came without a claim', async () => {
      const post = await n.staffPost(s.handler);
      const waiting = await n.claim(carol, post);
      await handOver(post, { recipientAccountId: s.bob.id }).expect(204);
      expect(await staffPost(post)).toMatchObject({
        handover: { claimId: null, recipient: { id: s.bob.id } },
      });
      expect(await claimsOf(post)).toMatchObject([
        { id: waiting, status: 'declined', declineReason: 'handed_to_another' },
      ]);
    });

    it('exactly one of a claim and a walk-in; a walk-in is a resident of the compound', async () => {
      const post = await n.post(s.alice);
      const id = await n.claim(s.bob, post);
      expect(fields(await handOver(post, {}).expect(400))).toEqual([
        { field: 'claimId', code: 'FIELD_REQUIRED' },
      ]);
      expect(
        fields(
          await handOver(post, {
            claimId: id,
            recipientAccountId: s.bob.id,
          }).expect(400),
        ),
      ).toEqual([{ field: 'recipientAccountId', code: 'FIELD_NOT_ALLOWED' }]);
      const other = await n.setUp();
      for (const recipientAccountId of [s.handler.id, other.bob.id])
        expect(
          fields(await handOver(post, { recipientAccountId }).expect(400)),
        ).toEqual([
          { field: 'recipientAccountId', code: 'RECIPIENT_NOT_ELIGIBLE' },
        ]);
      // A claim on another post is not this post's.
      const elsewhere = await n.claim(s.bob, await n.post(s.alice));
      expect(
        (await handOver(post, { claimId: elsewhere }).expect(404)).body,
      ).toMatchObject({ code: 'NEIGHBOUR_CLAIM_NOT_FOUND' });
    });

    it('only a found item is handed over; one nobody came for in time still is', async () => {
      const lost = await n.post(s.alice, { kind: 'lost', body: 'A cat' });
      expect(
        (await handOver(lost, { recipientAccountId: s.bob.id }).expect(409))
          .body,
      ).toMatchObject({ code: 'NEIGHBOUR_POST_NOT_CLAIMABLE' });
      const late = await n.post(s.alice);
      const id = await n.claim(s.bob, late);
      await n.expire(s.c, late);
      await handOver(late, { claimId: id }).expect(204);
      expect(await staffPost(late)).toMatchObject({
        closeReason: 'handed_over',
      });
    });

    it('a post that closes takes its pending claims with it', async () => {
      const post = await n.post(s.alice);
      const id = await n.claim(s.bob, post);
      await n
        .http('post', `/neighbour-posts/${post}/close`, s.alice.token, {
          reasonCode: 'resolved',
        })
        .expect(204);
      expect(await claimsOf(post)).toMatchObject([
        { id, status: 'declined', declineReason: 'post_closed' },
      ]);
      expect(
        (await n.notifications(s.c, s.bob.id)).filter(
          (x) => x.targetId === post,
        ),
      ).toMatchObject([{ kind: 'neighbour_claim.declined' }]);
    });
  });
});
