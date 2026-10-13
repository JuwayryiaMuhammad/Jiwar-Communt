import { DEFAULT_SUGGESTION_TOPICS } from '../../src/engagement/settings/defaults';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0040: what a compound's community life stands on — its settings row
 * and its closed list of suggestion topics, created with the compound — and
 * who may change them.
 */
describe('Community life — a new compound, its settings and its topics', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
  }, 60_000);

  afterAll(() => h.close());

  type Topic = { id: string; key: string; nameEn: string; active?: boolean };
  const topics = async (path: string, who: Who) =>
    (
      (await e.http('get', path, who.token).expect(200)).body as {
        data: Topic[];
      }
    ).data;

  it('a new compound gets its settings row and the six default topics, in its own transaction', async () => {
    const c = await e.x.compound();
    const rows = await e.x.asManager(c, async () => ({
      settings: await e.x.prisma.tenant.engagementSettings.findUniqueOrThrow({
        where: { tenantId: c.tenantId },
      }),
      topics: await e.x.prisma.tenant.suggestionTopic.findMany({
        orderBy: { key: 'asc' },
      }),
    }));
    expect(rows.settings.eventMaxGuests).toBe(2);
    const byKey = (p: { key: string }, q: { key: string }) =>
      p.key.localeCompare(q.key);
    expect(
      rows.topics.map((t) => ({
        key: t.key,
        nameAr: t.nameAr,
        nameEn: t.nameEn,
        active: t.active,
      })),
    ).toEqual(
      [...DEFAULT_SUGGESTION_TOPICS]
        .sort(byKey)
        .map((t) => ({ ...t, active: true })),
    );
    // Rows of its own: no other compound's.
    const mine = await topics('/community/suggestion-topics', s.manager);
    expect(
      mine
        .map((t) => t.id)
        .filter((id) => rows.topics.some((t) => t.id === id)),
    ).toEqual([]);
  });

  describe('settings', () => {
    it('the manager reads and changes the guest limit; the change is audited by value', async () => {
      expect(
        (
          await e
            .http('get', '/community/settings', s.manager.token)
            .expect(200)
        ).body,
      ).toEqual({ eventMaxGuests: 2 });
      expect(
        (
          await e
            .http('patch', '/community/settings', s.manager.token, {
              eventMaxGuests: 4,
            })
            .expect(200)
        ).body,
      ).toEqual({ eventMaxGuests: 4 });
      // The same value again writes no audit row.
      await e
        .http('patch', '/community/settings', s.manager.token, {
          eventMaxGuests: 4,
        })
        .expect(200);
      const rows = await e.x.asManager(s.c, () =>
        e.x.prisma.tenant.auditLog.findMany({
          where: { action: 'engagement.settings_changed' },
        }),
      );
      expect(rows.map((r) => r.changes)).toEqual([
        { eventMaxGuests: { from: 2, to: 4 } },
      ]);
    });

    it('out of range is refused with the range; a resident and a staff member without the permission are forbidden', async () => {
      for (const eventMaxGuests of [-1, 21, 1.5]) {
        const res = await e
          .http('patch', '/community/settings', s.manager.token, {
            eventMaxGuests,
          })
          .expect(400);
        expect((res.body as { fields: unknown[] }).fields).toEqual([
          {
            field: 'eventMaxGuests',
            code: 'INVALID_NUMBER',
            params: { min: 0, max: 20 },
          },
        ]);
      }
      const suggestionsOnly = await e.staff(s.c, ['community.suggestions']);
      for (const who of [s.owner, suggestionsOnly])
        await e.http('get', '/community/settings', who.token).expect(403);
    });
  });

  describe('suggestion topics', () => {
    it('the staff see all six with their state; a resident sees the active ones without it', async () => {
      const all = await topics('/community/suggestion-topics', s.manager);
      expect(all.map((t) => [t.key, t.active])).toEqual(
        [...DEFAULT_SUGGESTION_TOPICS]
          .map((t) => t.key)
          .sort()
          .map((key) => [key, true]),
      );
      const offered = await topics('/suggestion-topics', s.owner);
      expect(offered.map((t) => t.key)).toEqual(all.map((t) => t.key));
      expect(Object.keys(offered[0]).sort()).toEqual([
        'id',
        'key',
        'nameAr',
        'nameEn',
      ]);
    });

    it('a topic is added, renamed and retired; a retired one is no longer offered; the key never changes', async () => {
      const created = (
        await e
          .http('post', '/community/suggestion-topics', s.manager.token, {
            key: 'parking',
            nameAr: 'المواقف',
            nameEn: 'Parking',
          })
          .expect(201)
      ).body as Topic;
      expect(created).toMatchObject({ key: 'parking', active: true });
      // The same key again is a duplicate, named.
      const dup = await e
        .http('post', '/community/suggestion-topics', s.manager.token, {
          key: 'parking',
          nameAr: 'المواقف',
          nameEn: 'Parking again',
        })
        .expect(409);
      expect(dup.body).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
        fields: [{ field: 'key', code: 'DUPLICATE_VALUE' }],
      });
      const renamed = (
        await e
          .http(
            'patch',
            `/community/suggestion-topics/${created.id}`,
            s.manager.token,
            { nameEn: 'Car parks', active: false },
          )
          .expect(200)
      ).body as Topic;
      expect(renamed).toMatchObject({
        key: 'parking',
        nameEn: 'Car parks',
        active: false,
      });
      expect(
        (await topics('/suggestion-topics', s.owner)).map((t) => t.key),
      ).not.toContain('parking');
      // `key` is not a field of the update.
      const res = await e
        .http(
          'patch',
          `/community/suggestion-topics/${created.id}`,
          s.manager.token,
          { key: 'cars' },
        )
        .expect(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        { field: 'key', code: 'FIELD_NOT_ALLOWED' },
      ]);
    });

    it('topics are the suggestion handlers’: publishing alone does not manage them, and a resident cannot', async () => {
      const publisher = await e.staff(s.c, ['community.publish']);
      for (const who of [publisher, s.owner])
        await e
          .http('get', '/community/suggestion-topics', who.token)
          .expect(403);
      const handler = await e.staff(s.c, ['community.suggestions']);
      await e
        .http('get', '/community/suggestion-topics', handler.token)
        .expect(200);
      // The picker list is the resident's and the handler's.
      await e.http('get', '/suggestion-topics', handler.token).expect(200);
      await e.http('get', '/suggestion-topics', publisher.token).expect(403);
    });
  });
});
