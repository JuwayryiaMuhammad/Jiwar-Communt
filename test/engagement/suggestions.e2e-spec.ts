import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Mine {
  id: string;
  body: string | null;
  status: string;
  response: string | null;
  publicSummary: { titleEn: string | null; textEn: string | null } | null;
  supports: number;
  done: { noteEn: string | null; photoCount: number } | null;
  updates?: { status: string; response: string | null }[];
}

interface Board {
  id: string;
  summary: { titleEn: string | null; textEn: string | null };
  status: string;
  supports: number;
  supported: boolean;
}

/**
 * ADR 0040: suggestions — private to their author and the staff; moved
 * forward and answered; put on the public board under the staff's summary,
 * without the author; supported there; and, once done, shown in "you said,
 * we did".
 */
describe('Community life — suggestions, the board and "you said, we did"', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let neighbour: Who;

  const WORDS = 'My own words about the bench near gate two.';

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    neighbour = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
  }, 60_000);

  afterAll(() => h.close());

  const fieldsOf = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const mine = async (who: Who, id: string) =>
    (await e.http('get', `/suggestions/${id}`, who.token).expect(200))
      .body as Mine;
  const board = async (who: Who, query = '') =>
    (
      (await e.http('get', `/suggestion-board${query}`, who.token).expect(200))
        .body as { data: Board[] }
    ).data;
  const staff = (id: string, action: string, body?: object) =>
    e.http(
      action === 'response' || action === 'done-note' ? 'put' : 'post',
      `/community/suggestions/${id}/${action}`,
      s.manager.token,
      body,
    );

  describe('writing one', () => {
    it('under an active topic, with or without one of the author’s units; private to the author and the staff', async () => {
      const id = await e.suggestion(s.c, s.owner, {
        body: `  ${WORDS}  `,
        unitId: s.home.id,
      });
      expect(await mine(s.owner, id)).toMatchObject({
        body: WORDS,
        status: 'received',
        response: null,
        publicSummary: null,
        supports: 0,
        done: null,
        updates: [],
      });
      // Nobody else finds it: not a neighbour, not by its id, not on the board.
      await e.http('get', `/suggestions/${id}`, neighbour.token).expect(404);
      expect(
        (
          (await e.http('get', '/suggestions', neighbour.token).expect(200))
            .body as { data: Mine[] }
        ).data,
      ).toEqual([]);
      expect(await board(neighbour)).toEqual([]);
      // The staff read it with its author and unit.
      const inbox = (
        await e
          .http('get', `/community/suggestions/${id}`, s.manager.token)
          .expect(200)
      ).body as {
        body: string;
        author: { id: string; fullName: string };
        unitCode: string;
        erased: boolean;
      };
      expect(inbox).toMatchObject({
        body: WORDS,
        author: { id: s.owner.id },
        unitCode: s.home.code,
        erased: false,
      });
      expect(inbox.author.fullName).toMatch(/^Person /);
    });

    it('a retired topic, another’s unit and an empty text are refused', async () => {
      const retired = (
        await e
          .http('post', '/community/suggestion-topics', s.manager.token, {
            key: 'retired_topic',
            nameAr: 'قديم',
            nameEn: 'Old',
          })
          .expect(201)
      ).body as { id: string };
      await e
        .http(
          'patch',
          `/community/suggestion-topics/${retired.id}`,
          s.manager.token,
          { active: false },
        )
        .expect(200);
      const post = (over: object) =>
        e.http('post', '/suggestions', s.owner.token, {
          body: WORDS,
          ...over,
        });
      expect(fieldsOf(await post({ topicId: retired.id }).expect(400))).toEqual(
        [{ field: 'topicId', code: 'TOPIC_NOT_AVAILABLE' }],
      );
      const topicId = await e.topicId(s.c);
      const other = await e.unit(s.c, 'A');
      expect(
        (await post({ topicId, unitId: other.id }).expect(404)).body,
      ).toMatchObject({ code: 'UNIT_NOT_FOUND' });
      expect(
        fieldsOf(await post({ topicId, body: '   ' }).expect(400)),
      ).toEqual([
        {
          field: 'body',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 2000 },
        },
      ]);
    });

    it('an Idempotency-Key makes a retry the same suggestion, and its stored answer holds no text', async () => {
      const key = { 'Idempotency-Key': `suggestion-${Date.now()}` };
      const body = { topicId: await e.topicId(s.c), body: WORDS };
      const first = await e
        .http('post', '/suggestions', s.owner.token, body, key)
        .expect(201);
      const again = await e
        .http('post', '/suggestions', s.owner.token, body, key)
        .expect(201);
      expect(again.body).toEqual(first.body);
      expect(Object.keys(first.body as object).sort()).toEqual([
        'createdAt',
        'id',
      ]);
    });
  });

  describe('moving and answering', () => {
    it('forward only, each step and each answer kept in order; declining needs an answer; the ends are final', async () => {
      const id = await e.suggestion(s.c, s.owner);
      await e.move(s.manager, id, 'under_review').expect(204);
      await e.move(s.manager, id, 'planned', 'We will buy two.').expect(204);
      const back = await e.move(s.manager, id, 'under_review').expect(409);
      expect(back.body).toMatchObject({
        code: 'SUGGESTION_INVALID_STATE',
        params: { status: 'planned', published: false },
      });
      await staff(id, 'response', { response: 'Three, in fact.' }).expect(204);
      await e.move(s.manager, id, 'done').expect(204);
      expect(await mine(s.owner, id)).toMatchObject({
        status: 'done',
        response: 'Three, in fact.',
        updates: [
          { status: 'under_review', response: null },
          { status: 'planned', response: 'We will buy two.' },
          { status: 'planned', response: 'Three, in fact.' },
          { status: 'done', response: null },
        ],
      });
      // No staff member is named to the author.
      expect(JSON.stringify(await mine(s.owner, id))).not.toContain(
        s.manager.id,
      );
      for (const status of ['declined', 'planned'])
        await e.move(s.manager, id, status, 'x').expect(409);

      const other = await e.suggestion(s.c, s.owner);
      expect(
        fieldsOf(await e.move(s.manager, other, 'declined').expect(400)),
      ).toEqual([{ field: 'response', code: 'FIELD_REQUIRED' }]);
      await e.move(s.manager, other, 'declined', 'Not possible.').expect(204);
      await e.move(s.manager, other, 'done').expect(409);
    });

    it('the author is told of each move and each answer, by status and topic key and nothing else', async () => {
      const id = await e.suggestion(s.c, s.owner, { body: WORDS });
      const told = async () =>
        (
          await e.notifications(
            s.c,
            s.owner.id,
            'community_suggestion.status_changed',
          )
        ).filter((n) => n.targetId === id);
      expect(await told()).toEqual([]);
      await e.move(s.manager, id, 'under_review').expect(204);
      await staff(id, 'response', { response: 'A SECRET ANSWER' }).expect(204);
      const rows = await told();
      expect(rows.map((n) => n.params)).toEqual([
        { status: 'under_review', topicKey: 'general' },
        { status: 'under_review', topicKey: 'general' },
      ]);
      expect(rows[0].targetType).toBe('community_suggestion');
      const everything = JSON.stringify(rows);
      expect(everything).not.toContain('SECRET');
      expect(everything).not.toContain('bench');
      // Publishing, supporting and the "we did" note tell nobody.
      await e.publish(s.manager, id).expect(204);
      await e
        .http('put', `/suggestion-board/${id}/support`, neighbour.token)
        .expect(204);
      expect(await told()).toHaveLength(2);
    });

    it('handling suggestions is its own permission: a publisher cannot, and a handler cannot publish announcements', async () => {
      const id = await e.suggestion(s.c, s.owner);
      const publisher = await e.staff(s.c, ['community.publish']);
      const handler = await e.staff(s.c, ['community.suggestions']);
      await e
        .http('get', `/community/suggestions/${id}`, publisher.token)
        .expect(403);
      await e
        .http('get', `/community/suggestions/${id}`, handler.token)
        .expect(200);
      await e.move(handler, id, 'under_review').expect(204);
      await e
        .http('get', '/community/announcements', handler.token)
        .expect(403);
      // Neither is a resident: the board and one's own list are not theirs.
      for (const path of ['/suggestion-board', '/suggestions'])
        await e.http('get', path, handler.token).expect(403);
    });
  });

  describe('the board', () => {
    it('shows the staff’s summary, never the resident’s words or who they are', async () => {
      const id = await e.suggestion(s.c, s.owner, {
        body: WORDS,
        unitId: s.home.id,
      });
      expect(
        fieldsOf(
          await staff(id, 'publish', { titleEn: 'Only a title' }).expect(400),
        ),
      ).toEqual([{ field: 'textEn', code: 'FIELD_REQUIRED' }]);
      expect(fieldsOf(await staff(id, 'publish', {}).expect(400))).toEqual([
        { field: 'titleEn', code: 'FIELD_REQUIRED' },
      ]);
      await e.publish(s.manager, id).expect(204);

      const seen = await board(neighbour);
      const item = seen.find((b) => b.id === id)!;
      expect(item).toMatchObject({
        summary: {
          titleEn: 'More benches',
          textEn: 'Residents asked for more places to sit.',
        },
        status: 'received',
        supports: 0,
        supported: false,
      });
      const shown = JSON.stringify(seen);
      for (const secret of [WORDS, 'bench near gate', s.owner.id, s.home.id])
        expect(shown).not.toContain(secret);
      expect(Object.keys(item).sort()).toEqual([
        'done',
        'id',
        'publishedAt',
        'status',
        'summary',
        'supported',
        'supports',
        'topic',
      ]);
      // The author sees how theirs is shown, and still their own words.
      expect(await mine(s.owner, id)).toMatchObject({
        body: WORDS,
        publicSummary: { titleEn: 'More benches' },
      });
      // The summary may be rewritten; it stays where it was on the board.
      await e
        .publish(s.manager, id, { titleEn: 'Benches', textEn: 'More seats.' })
        .expect(204);
      expect(
        (await board(neighbour)).find((b) => b.id === id)!.summary,
      ).toEqual({
        titleEn: 'Benches',
        textEn: 'More seats.',
        titleAr: null,
        textAr: null,
      });
    });

    it('one support per account, taken back at will; supporting twice or taking back nothing changes nothing', async () => {
      const id = await e.suggestion(s.c, s.owner);
      await e.publish(s.manager, id).expect(204);
      const support = (who: Who, method: 'put' | 'delete' = 'put') =>
        e.http(method, `/suggestion-board/${id}/support`, who.token);
      await support(neighbour).expect(204);
      await support(neighbour).expect(204);
      await support(s.owner).expect(204);
      expect((await board(neighbour)).find((b) => b.id === id)).toMatchObject({
        supports: 2,
        supported: true,
      });
      await support(neighbour, 'delete').expect(204);
      await support(neighbour, 'delete').expect(204);
      const third = await e.owner(s.c, (await e.unit(s.c, 'A')).id);
      expect((await board(third)).find((b) => b.id === id)).toMatchObject({
        supports: 1,
        supported: false,
      });
      // Audited once per real change, by the supporter.
      const audit = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.auditLog.findMany({
          where: { targetId: id, actorId: neighbour.id },
          orderBy: { occurredAt: 'asc' },
        }),
      );
      expect(audit.map((r) => r.action)).toEqual([
        'suggestion.supported',
        'suggestion.unsupported',
      ]);
    });

    it('unpublishing takes it and its summary off; a suggestion not on the board cannot be supported or found there', async () => {
      const id = await e.suggestion(s.c, s.owner);
      await e
        .http('put', `/suggestion-board/${id}/support`, neighbour.token)
        .expect(404);
      await e.publish(s.manager, id).expect(204);
      await e
        .http('put', `/suggestion-board/${id}/support`, neighbour.token)
        .expect(204);
      await staff(id, 'unpublish').expect(204);
      expect((await board(neighbour)).map((b) => b.id)).not.toContain(id);
      expect(await mine(s.owner, id)).toMatchObject({
        publicSummary: null,
        supports: 0,
      });
      const row = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.suggestion.findUniqueOrThrow({ where: { id } }),
      );
      expect([row.publicTitleEn, row.publicTextEn, row.publishedAt]).toEqual([
        null,
        null,
        null,
      ]);
      for (const method of ['put', 'delete'] as const)
        await e
          .http(method, `/suggestion-board/${id}/support`, neighbour.token)
          .expect(404);
      expect((await staff(id, 'unpublish').expect(409)).body).toMatchObject({
        code: 'SUGGESTION_INVALID_STATE',
        params: { published: false },
      });
      // The staff's filter tells the two apart.
      const published = await e.suggestion(s.c, s.owner);
      await e.publish(s.manager, published).expect(204);
      const inbox = async (query: string) =>
        (
          (
            await e
              .http('get', `/community/suggestions${query}`, s.manager.token)
              .expect(200)
          ).body as { data: { id: string }[] }
        ).data.map((x) => x.id);
      expect(await inbox('?published=true&limit=100')).toContain(published);
      expect(await inbox('?published=true&limit=100')).not.toContain(id);
      expect(await inbox('?published=false&limit=100')).toContain(id);
    });
  });

  describe('you said, we did', () => {
    it('a done suggestion with the staff’s note and photos is listed; a note is a done suggestion’s only', async () => {
      const id = await e.suggestion(s.c, s.owner, { body: WORDS });
      expect(
        (await staff(id, 'done-note', { noteEn: 'Too early' }).expect(409))
          .body,
      ).toMatchObject({
        code: 'SUGGESTION_INVALID_STATE',
        params: { status: 'received' },
      });
      await e.publish(s.manager, id).expect(204);
      await e.move(s.manager, id, 'done').expect(204);
      const done = async (who: Who) =>
        (
          (await e.http('get', '/suggestion-board/done', who.token).expect(200))
            .body as {
            data: {
              id: string;
              summary: { titleEn: string } | null;
              done: {
                noteEn: string;
                photoCount: number;
                photos: { contentType: string; url: string }[];
              };
            }[];
          }
        ).data;
      // Done, but nothing said yet about what was done: not listed.
      expect((await done(neighbour)).map((d) => d.id)).not.toContain(id);
      expect(fieldsOf(await staff(id, 'done-note', {}).expect(400))).toEqual([
        { field: 'noteEn', code: 'FIELD_REQUIRED' },
      ]);

      const [before, after] = [
        await e.attachment(s.manager),
        await e.attachment(s.manager, 'image/jpeg'),
      ];
      await staff(id, 'done-note', {
        noteEn: 'Three benches were installed.',
        attachmentFileIds: [before, after],
      }).expect(204);
      const item = (await done(neighbour)).find((d) => d.id === id)!;
      expect(item).toMatchObject({
        summary: { titleEn: 'More benches' },
        done: { noteEn: 'Three benches were installed.', photoCount: 2 },
      });
      expect(item.done.photos.map((p) => p.contentType)).toEqual([
        'image/png',
        'image/jpeg',
      ]);
      expect(await fetch(item.done.photos[0].url).then((r) => r.status)).toBe(
        200,
      );
      const shown = JSON.stringify(await done(neighbour));
      for (const secret of [WORDS, s.owner.id, s.home.id])
        expect(shown).not.toContain(secret);
      // The author's own view carries the note too.
      expect((await mine(s.owner, id)).done).toMatchObject({
        noteEn: 'Three benches were installed.',
        photoCount: 2,
      });
      // Rewriting the note keeps a photo and drops the other.
      await staff(id, 'done-note', {
        noteEn: 'Three benches, and a fourth soon.',
        attachmentFileIds: [
          (
            (
              await e
                .http('get', `/community/suggestions/${id}`, s.manager.token)
                .expect(200)
            ).body as { done: { photos: { id: string }[] } }
          ).done.photos[1].id,
        ],
      }).expect(204);
      expect(
        (await done(neighbour)).find((d) => d.id === id)!.done,
      ).toMatchObject({
        noteEn: 'Three benches, and a fourth soon.',
        photoCount: 1,
      });
    });

    it('a done suggestion that was never published is listed by its note alone, without a summary or a word of it', async () => {
      const id = await e.suggestion(s.c, s.owner, { body: WORDS });
      await e.move(s.manager, id, 'done').expect(204);
      await staff(id, 'done-note', { noteAr: 'تم الإصلاح.' }).expect(204);
      const list = (
        (
          await e
            .http('get', '/suggestion-board/done', neighbour.token)
            .expect(200)
        ).body as {
          data: { id: string; summary: unknown; supports: number }[];
        }
      ).data;
      expect(list.find((d) => d.id === id)).toMatchObject({
        summary: null,
        supports: 0,
      });
      expect(JSON.stringify(list)).not.toContain(WORDS);
    });
  });
});
