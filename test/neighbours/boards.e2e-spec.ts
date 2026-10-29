import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';
import { today } from '../setup/compound-clock';

/**
 * ADR 0042: the lost-and-found and lending boards. What a post shows of
 * its author (a building, never a name), how long it stays, who takes it
 * down, and what the staff see of both boards.
 */
describe('Neighbours — the lost-and-found and lending boards', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    audit = auditReaders(h);
    await n.settings(s.c, s.manager, { maxOpenPosts: 50 });
  }, 180_000);

  afterAll(() => h.close());

  type Post = Record<string, unknown> & { id: string; kind: string };
  const board = (who: Who, query = '') =>
    n.list<Post>(`/neighbour-posts${query}`, who);
  const read = (who: Who, id: string) =>
    n.http('get', `/neighbour-posts/${id}`, who.token);
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  // eslint-disable-next-line no-restricted-syntax -- a real 24 h: a post expires createdAt + days × 24 h
  const DAY = 86_400_000;

  describe('posting', () => {
    it('a resident posts a found item with a photo, a place and a day; it stays thirty days', async () => {
      const photo = await n.file(s.alice, 'neighbour_post_photo');
      const res = await n
        .http('post', '/neighbour-posts', s.alice.token, {
          kind: 'found',
          body: '  A set of keys with a red tag  ',
          place: ' Near gate 2 ',
          occurredOn: today(),
          photoFileIds: [photo],
        })
        .expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const created = res.body as {
        id: string;
        kind: string;
        expiresAt: string;
        createdAt: string;
      };
      expect(Object.keys(created).sort()).toEqual([
        'createdAt',
        'expiresAt',
        'id',
        'kind',
      ]);
      expect(
        new Date(created.expiresAt).getTime() -
          new Date(created.createdAt).getTime(),
      ).toBe(30 * DAY);
      const seen = (await read(s.bob, created.id).expect(200)).body as Post;
      expect(seen).toMatchObject({
        id: created.id,
        board: 'lost_found',
        kind: 'found',
        body: 'A set of keys with a red tag',
        place: 'Near gate 2',
        state: 'open',
        mine: false,
        claimable: true,
        myClaim: null,
        closeReason: null,
        author: { kind: 'resident', building: 'A' },
      });
      const photos = seen.photos as { contentType: string; url: string }[];
      expect(photos).toHaveLength(1);
      expect((await fetch(photos[0].url)).status).toBe(200);
      // Her own view: hers, and so not hers to claim.
      expect((await read(s.alice, created.id).expect(200)).body).toMatchObject({
        mine: true,
        claimable: false,
      });
    });

    it('another resident sees a building and never a name, a unit or an account', async () => {
      const id = await n.post(s.alice, { kind: 'lost', body: 'A grey cat' });
      const alice = await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.account.findUniqueOrThrow({
          where: { id: s.alice.id },
        }),
      );
      const text = JSON.stringify([
        (await read(s.bob, id).expect(200)).body,
        await board(s.bob),
      ]);
      for (const secret of [
        s.alice.id,
        alice.fullName!,
        alice.fullName!.split(' ')[0],
        s.homeA.id,
        s.homeA.code,
      ])
        expect(text).not.toContain(secret);
      expect(text).toContain('"building":"A"');
    });

    it('a unit that names no building shows none', async () => {
      const home = await n.unit(s.c, null);
      const who = await n.owner(s.c, home.id);
      const id = await n.post(who);
      expect((await read(s.bob, id).expect(200)).body).toMatchObject({
        author: { kind: 'resident', building: null },
      });
    });

    it('lending: can lend and wants to borrow, fourteen days, no day and no claim', async () => {
      const lend = await n.post(s.alice, {
        kind: 'lend',
        body: 'A ladder',
        place: undefined,
      });
      const borrow = await n.post(s.bob, { kind: 'borrow', body: 'A drill' });
      const row = await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.neighbourPost.findUniqueOrThrow({
          where: { id: lend },
        }),
      );
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(14 * DAY);
      expect((await read(s.bob, lend).expect(200)).body).toMatchObject({
        board: 'lending',
        claimable: false,
      });
      expect(
        fields(
          await n
            .http('post', '/neighbour-posts', s.alice.token, {
              kind: 'lend',
              body: 'A bike',
              occurredOn: '2026-01-01',
            })
            .expect(400),
        ),
      ).toEqual([{ field: 'occurredOn', code: 'FIELD_NOT_ALLOWED' }]);
      expect(
        (await board(s.alice, '?board=lending')).map((p) => p.id).sort(),
      ).toEqual([lend, borrow].sort());
      expect((await board(s.alice, '?kind=borrow')).map((p) => p.id)).toEqual([
        borrow,
      ]);
    });

    it('refuses a day in the future or that does not exist, too many photos, and someone else’s unit or file', async () => {
      const post = (over: object, who: Who = s.alice) =>
        n.http('post', '/neighbour-posts', who.token, {
          kind: 'lost',
          body: 'A wallet',
          ...over,
        });
      expect(
        fields(await post({ occurredOn: '2999-01-01' }).expect(400)),
      ).toEqual([{ field: 'occurredOn', code: 'INVALID_VALUE' }]);
      // A day that does not exist fails as its shape would, in the DTO.
      for (const occurredOn of ['1/2/2026', '2026-02-30', '2026-13-01'])
        expect(fields(await post({ occurredOn }).expect(400))).toEqual([
          { field: 'occurredOn', code: 'INVALID_FORMAT' },
        ]);
      const four = [];
      for (let i = 0; i < 4; i++)
        four.push(await n.file(s.alice, 'neighbour_post_photo'));
      expect(fields(await post({ photoFileIds: four }).expect(400))).toEqual([
        {
          field: 'photoFileIds',
          code: 'INVALID_LENGTH',
          params: { min: 0, max: 3 },
        },
      ]);
      const bobs = await n.file(s.bob, 'neighbour_post_photo');
      expect(fields(await post({ photoFileIds: [bobs] }).expect(400))).toEqual([
        { field: 'photoFileIds.0', code: 'FILE_NOT_AVAILABLE' },
      ]);
      expect(
        (await post({ unitId: s.homeB.id }).expect(404)).body,
      ).toMatchObject({ code: 'UNIT_NOT_FOUND' });
      // A PDF is not a photo: the upload itself is refused.
      const pdf = await h
        .http()
        .post('/api/v1/files/uploads')
        .set('Authorization', `Bearer ${s.alice.token}`)
        .send({
          purpose: 'neighbour_post_photo',
          contentType: 'application/pdf',
          size: 10,
        });
      expect(pdf.status).toBe(400);
    });

    it('is audited by its kind: never its words or its place', async () => {
      const id = await n.post(s.alice, {
        body: 'AUDIT-FREE-TEXT keys',
        place: 'AUDIT-FREE-TEXT place',
      });
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_post.created',
        targetId: id,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({
        kind: 'found',
        side: 'resident',
        photos: 0,
      });
      expect(JSON.stringify(rows[0])).not.toContain('AUDIT-FREE-TEXT');
    });
  });

  describe('how many, and how long', () => {
    it('an author has as many posts on the boards as the compound allows, and not one more', async () => {
      const c = await n.setUp();
      await n.settings(c.c, c.manager, { maxOpenPosts: 2 });
      const first = await n.post(c.alice);
      await n.post(c.alice, { kind: 'lend', body: 'A ladder' });
      const third = await n
        .http('post', '/neighbour-posts', c.alice.token, {
          kind: 'lost',
          body: 'A scarf',
        })
        .expect(409);
      expect(third.body).toMatchObject({
        code: 'NEIGHBOUR_POST_LIMIT_REACHED',
        params: { max: 2 },
      });
      // A closed post, and one whose day passed, no longer count.
      await n
        .http('post', `/neighbour-posts/${first}/close`, c.alice.token, {
          reasonCode: 'resolved',
        })
        .expect(204);
      const again = await n.post(c.alice);
      await n.expire(c.c, again);
      await n.post(c.alice);
      // Another author has their own count.
      await n.post(c.bob);
    });

    it('three posts at once with one place left: one is posted', async () => {
      const c = await n.setUp();
      await n.settings(c.c, c.manager, { maxOpenPosts: 1 });
      const results = await Promise.all(
        ['lost', 'found', 'lend'].map((kind) =>
          n.http('post', '/neighbour-posts', c.alice.token, {
            kind,
            body: 'Something',
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });

    it('a post leaves its board on its day by the reader’s clock; its author keeps it, the desk sees it flagged', async () => {
      const id = await n.post(s.alice, { body: 'An umbrella' });
      expect((await board(s.bob)).map((p) => p.id)).toContain(id);
      await n.expire(s.c, id);
      expect((await board(s.bob)).map((p) => p.id)).not.toContain(id);
      expect((await read(s.bob, id).expect(404)).body).toMatchObject({
        code: 'NEIGHBOUR_POST_NOT_FOUND',
      });
      expect((await read(s.alice, id).expect(200)).body).toMatchObject({
        state: 'expired',
        mine: true,
      });
      expect(
        (await board(s.alice, '?mine=true')).find((p) => p.id === id),
      ).toMatchObject({ state: 'expired' });
      expect(
        (await n.list<Post>('/neighbours/posts?state=expired', s.handler)).map(
          (p) => p.id,
        ),
      ).toContain(id);
      // Nothing was written to make it so: the row is still open.
      const row = await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.neighbourPost.findUniqueOrThrow({ where: { id } }),
      );
      expect(row.status).toBe('open');
    });

    it('a new limit of days applies to posts written from then on', async () => {
      const before = await n.post(s.alice, { kind: 'lend', body: 'A tent' });
      await n.settings(s.c, s.manager, { lendingExpiryDays: 3 });
      const after = await n.post(s.alice, { kind: 'lend', body: 'A stove' });
      await n.settings(s.c, s.manager, { lendingExpiryDays: 14 });
      const days = async (id: string) => {
        const row = await n.x.asManager(s.c, () =>
          n.x.prisma.tenant.neighbourPost.findUniqueOrThrow({ where: { id } }),
        );
        return (row.expiresAt.getTime() - row.createdAt.getTime()) / DAY;
      };
      expect([await days(before), await days(after)]).toEqual([14, 3]);
    });
  });

  describe('taking a post down', () => {
    it('its author closes it with a reason from their list; nobody else does', async () => {
      const id = await n.post(s.alice);
      const close = (who: Who, reasonCode: string) =>
        n.http('post', `/neighbour-posts/${id}/close`, who.token, {
          reasonCode,
        });
      await close(s.bob, 'resolved').expect(404);
      expect(fields(await close(s.alice, 'inappropriate').expect(400))).toEqual(
        [
          {
            field: 'reasonCode',
            code: 'INVALID_REASON_CODE',
            params: { allowed: ['resolved', 'no_longer_needed'] },
          },
        ],
      );
      await close(s.alice, 'no_longer_needed').expect(204);
      expect((await close(s.alice, 'resolved').expect(409)).body).toMatchObject(
        {
          code: 'NEIGHBOUR_POST_NOT_OPEN',
          params: { state: 'closed' },
        },
      );
      expect((await read(s.alice, id).expect(200)).body).toMatchObject({
        state: 'closed',
        closeReason: 'no_longer_needed',
      });
      await read(s.bob, id).expect(404);
      expect(
        await audit.tenant(s.c.tenantId, {
          action: 'neighbour_post.closed',
          targetId: id,
        }),
      ).toHaveLength(1);
    });

    it('the staff take down a post of either board, with a reason, and its author is told', async () => {
      for (const kind of ['found', 'borrow']) {
        const id = await n.post(s.alice, { kind, body: 'Something' });
        const remove = (who: Who, reasonCode: string) =>
          n.http('post', `/neighbours/posts/${id}/remove`, who.token, {
            reasonCode,
          });
        await remove(s.alice, 'inappropriate').expect(403);
        await remove(s.handler, 'resolved').expect(400);
        await remove(s.handler, 'not_allowed').expect(204);
        await read(s.bob, id).expect(404);
        expect((await read(s.alice, id).expect(200)).body).toMatchObject({
          state: 'closed',
          closeReason: 'not_allowed',
        });
        const told = (await n.notifications(s.c, s.alice.id)).filter(
          (x) => x.targetId === id,
        );
        expect(told).toMatchObject([
          { kind: 'neighbour_post.removed', params: { postKind: kind } },
        ]);
        const rows = await audit.tenant(s.c.tenantId, {
          action: 'neighbour_post.removed',
          targetId: id,
        });
        expect(rows[0].metadata).toEqual({ kind, reasonCode: 'not_allowed' });
      }
    });
  });

  describe('the staff', () => {
    it('post lost and found items as the management, and never on the lending board', async () => {
      const id = await n.staffPost(s.handler, {
        kind: 'found',
        body: 'A phone left at the pool',
      });
      expect((await read(s.alice, id).expect(200)).body).toMatchObject({
        author: { kind: 'management', building: null },
        claimable: true,
      });
      const text = JSON.stringify((await read(s.alice, id)).body);
      expect(text).not.toContain(s.handler.id);
      for (const [body, field, code] of [
        [{ kind: 'lend', body: 'A van' }, 'kind', 'INVALID_VALUE'],
        [
          { kind: 'found', body: 'Keys', unitId: s.homeA.id },
          'unitId',
          'FIELD_NOT_ALLOWED',
        ],
      ] as const)
        expect(
          fields(
            await n
              .http('post', '/neighbours/posts', s.handler.token, body)
              .expect(400),
          )[0],
        ).toMatchObject({ field, code });
      // A resident does not post as the management.
      await n
        .http('post', '/neighbours/posts', s.alice.token, {
          kind: 'found',
          body: 'Keys',
        })
        .expect(403);
    });

    it('read both boards with who posted, by name and unit', async () => {
      const lend = await n.post(s.alice, {
        kind: 'lend',
        body: 'A wheelbarrow',
      });
      const list = await n.list<Post>(
        '/neighbours/posts?board=lending&state=open',
        s.handler,
      );
      const row = list.find((p) => p.id === lend)!;
      expect(row).toMatchObject({
        author: { id: s.alice.id, fullName: expect.any(String) as string },
        authorSide: 'resident',
        authorUnit: { id: s.homeA.id, code: s.homeA.code, building: 'A' },
        pendingClaims: 0,
        handover: null,
      });
      expect(
        (
          await n
            .http('get', `/neighbours/posts/${lend}`, s.handler.token)
            .expect(200)
        ).body,
      ).toMatchObject({ id: lend, board: 'lending' });
      expect(list.every((p) => p.board === 'lending')).toBe(true);
    });

    it('another compound’s post is not found, for a resident and for the staff', async () => {
      const other = await n.setUp();
      const theirs = await n.post(other.alice);
      await read(s.bob, theirs).expect(404);
      for (const [method, path, body] of [
        ['get', `/neighbours/posts/${theirs}`, undefined],
        ['get', `/neighbours/posts/${theirs}/claims`, undefined],
        [
          'post',
          `/neighbours/posts/${theirs}/remove`,
          { reasonCode: 'duplicate' },
        ],
      ] as const)
        expect(
          (await n.http(method, path, s.handler.token, body).expect(404)).body,
        ).toMatchObject({ code: 'NEIGHBOUR_POST_NOT_FOUND' });
    });
  });
});
