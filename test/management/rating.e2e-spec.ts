import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';

/**
 * ADR 0039: the author rates a closed request, 1 to 5 with an optional
 * comment, once and for good. The author reads their own rating; among the
 * staff only `requests.manage` reads ratings — a handler without it finds
 * none on any route.
 */
describe('Management requests — rating', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let handler: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    handler = await m.handler(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const closed = async (who: Who = s.owner) => {
    const { id } = await m.open(s.c, who);
    await m
      .http('post', `/management/requests/${id}/close`, handler.token, {
        reasonCode: 'resolved',
      })
      .expect(204);
    return id;
  };
  const rate = (id: string, body: object, who: Who = s.owner) =>
    m.http('post', `/management-requests/${id}/rating`, who.token, body);
  const COMMENT = 'RATING-COMMENT quick and kind';

  it('the author rates a closed request and reads the rating back on it', async () => {
    const id = await closed();
    const res = await rate(id, { rating: 4, comment: `  ${COMMENT}  ` }).expect(
      201,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      rating: 4,
      comment: COMMENT,
      createdAt: expect.any(String) as string,
    });
    const detail = await m
      .http('get', `/management-requests/${id}`, s.owner.token)
      .expect(200);
    expect((detail.body as { rating: unknown }).rating).toEqual(res.body);
  });

  it('a comment is optional: none, or blank, is no comment', async () => {
    for (const body of [{ rating: 5 }, { rating: 1, comment: '   ' }]) {
      const res = await rate(await closed(), body).expect(201);
      expect(res.body).toMatchObject({ rating: body.rating, comment: null });
    }
  });

  it('1 to 5, whole numbers; a comment up to 1000 characters', async () => {
    const id = await closed();
    for (const rating of [0, 6, 2.5, '4', null]) {
      const res = await rate(id, { rating }).expect(400);
      expect(res.body).toMatchObject({ fields: [{ field: 'rating' }] });
    }
    const long = await rate(id, {
      rating: 3,
      comment: 'x'.repeat(1001),
    }).expect(400);
    expect(long.body).toMatchObject({
      fields: [{ field: 'comment', code: 'INVALID_LENGTH' }],
    });
    // Nothing was recorded by the refused attempts.
    await rate(id, { rating: 3, comment: 'x'.repeat(1000) }).expect(201);
  });

  it('once per request: a second rating is refused, and the first stands', async () => {
    const id = await closed();
    await rate(id, { rating: 2, comment: 'Slow' }).expect(201);
    const again = await rate(id, {
      rating: 5,
      comment: 'Changed my mind',
    }).expect(409);
    expect(again.body).toMatchObject({
      code: 'MANAGEMENT_REQUEST_ALREADY_RATED',
    });
    const detail = await m
      .http('get', `/management-requests/${id}`, s.owner.token)
      .expect(200);
    expect(detail.body).toMatchObject({
      rating: { rating: 2, comment: 'Slow' },
    });
  });

  it('two ratings at once: one is recorded', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await closed();
      const results = await Promise.all([
        rate(id, { rating: 1 }),
        rate(id, { rating: 5 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const rows = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequestRating.findMany({
          where: { requestId: id },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rating).toBe(
        (results.find((r) => r.status === 201)!.body as { rating: number })
          .rating,
      );
    }
  });

  it('only after it closed: a live request is not rated', async () => {
    const { id } = await m.open(s.c, s.owner);
    const open = await rate(id, { rating: 5 }).expect(409);
    expect(open.body).toMatchObject({
      code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
      params: { status: 'open' },
    });
    await m
      .http('post', `/management/requests/${id}/messages`, handler.token, {
        body: 'Answer',
        official: true,
      })
      .expect(201);
    await rate(id, { rating: 5 }).expect(409);
  });

  it('a withdrawn request is rated like any closed one; reopened and closed again it keeps its rating and takes no second', async () => {
    const { id } = await m.open(s.c, s.owner);
    await m
      .http('post', `/management-requests/${id}/withdraw`, s.owner.token)
      .expect(204);
    await rate(id, { rating: 3 }).expect(201);
    await m
      .http('post', `/management-requests/${id}/reopen`, s.owner.token, {
        body: 'Again',
      })
      .expect(204);
    await m
      .http('post', `/management/requests/${id}/close`, handler.token, {
        reasonCode: 'resolved',
      })
      .expect(204);
    const again = await rate(id, { rating: 5 }).expect(409);
    expect(again.body).toMatchObject({
      code: 'MANAGEMENT_REQUEST_ALREADY_RATED',
    });
  });

  it('only the author rates: not the household, another resident or the staff', async () => {
    const id = await closed();
    const member = await m.x.joinFamily(s.c, s.unit.id, s.owner);
    const family = await m.who(s.c, member.id, 'family');
    await rate(id, { rating: 1 }, family).expect(404);
    const other = await m.setUp();
    await rate(id, { rating: 1 }, other.owner).expect(404);
    await rate(id, { rating: 1 }, handler).expect(403);
    await rate(id, { rating: 1 }, s.manager).expect(403);
  });

  describe('who reads ratings', () => {
    let id: string;

    beforeAll(async () => {
      id = await closed();
      await rate(id, { rating: 2, comment: COMMENT }).expect(201);
    });

    it('requests.manage reads a request’s rating, and null before there is one', async () => {
      const res = await m
        .http('get', `/management/requests/${id}/rating`, s.manager.token)
        .expect(200);
      expect(res.body).toEqual({
        rating: {
          rating: 2,
          comment: COMMENT,
          createdAt: expect.any(String) as string,
        },
      });
      const unrated = await closed();
      const none = await m
        .http('get', `/management/requests/${unrated}/rating`, s.manager.token)
        .expect(200);
      expect(none.body).toEqual({ rating: null });
    });

    it('requests.manage lists the ratings, newest first, each with its request, paged', async () => {
      const page = async (query: string) =>
        (
          await m
            .http(
              'get',
              `/management/request-ratings?${query}`,
              s.manager.token,
            )
            .expect(200)
        ).body as {
          data: {
            rating: number;
            createdAt: string;
            request: { id: string; number: string; author: { id: string } };
          }[];
          nextCursor: string | null;
        };
      const all = await page('limit=100');
      expect(all.data.length).toBeGreaterThan(5);
      const times = all.data.map((r) => r.createdAt);
      expect(times).toEqual([...times].sort().reverse());
      expect(all.data.map((r) => r.request.id)).toContain(id);
      expect(all.data[0].request).toMatchObject({
        number: expect.stringMatching(/^MR-\d{6}$/) as string,
        author: { id: s.owner.id },
      });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const p = await page(`limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...p.data.map((r) => r.request.id));
        cursor = p.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all.data.map((r) => r.request.id));
    });

    it('a handler without requests.manage reads no rating: not on the two routes, the request, the inbox or the conversation', async () => {
      await m
        .http('get', `/management/requests/${id}/rating`, handler.token)
        .expect(403);
      await m
        .http('get', '/management/request-ratings', handler.token)
        .expect(403);
      const reads: unknown[] = [];
      for (const path of [
        `/management/requests/${id}`,
        `/management/requests/${id}/messages?limit=100`,
        '/management/requests?limit=100',
        '/management/requests?status=closed&limit=100',
        '/management/appointments?limit=100',
      ])
        reads.push((await m.http('get', path, handler.token).expect(200)).body);
      const seen = JSON.stringify(reads);
      expect(seen).not.toContain('RATING-COMMENT');
      expect(seen).not.toMatch(/"rating"|"rated"|"comment"/);
    });

    it('the manager’s own request views carry no rating either: it is read on its routes', async () => {
      const res = await m
        .http('get', `/management/requests/${id}`, s.manager.token)
        .expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/"rating"|RATING-COMMENT/);
    });

    it('another compound’s manager finds no such request', async () => {
      const other = await m.setUp();
      await m
        .http('get', `/management/requests/${id}/rating`, other.manager.token)
        .expect(404);
    });
  });
});
