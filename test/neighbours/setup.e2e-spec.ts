import { DEFAULT_COMPLAINT_CATEGORIES } from '../../src/neighbours/settings/defaults';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: what a compound's neighbours domain stands on — its settings
 * row, its complaint counter, an empty welcome template and its closed
 * list of complaint categories, created with the compound — and who may
 * change them.
 */
describe('Neighbours — a new compound, its settings and its categories', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    audit = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  type Category = { id: string; key: string; nameEn: string; active?: boolean };
  const categories = (path: string, who: Who) => n.list<Category>(path, who);

  it('a new compound gets its settings, a counter at zero, an empty welcome and the eight categories', async () => {
    const c = await n.x.compound();
    const rows = await n.x.asManager(c, async () => ({
      settings: await n.x.prisma.tenant.neighbourSettings.findUniqueOrThrow({
        where: { tenantId: c.tenantId },
      }),
      counter:
        await n.x.prisma.tenant.neighbourComplaintCounter.findUniqueOrThrow({
          where: { tenantId: c.tenantId },
        }),
      template:
        await n.x.prisma.tenant.neighbourWelcomeTemplate.findUniqueOrThrow({
          where: { tenantId: c.tenantId },
        }),
      categories: await n.x.prisma.tenant.neighbourComplaintCategory.findMany(),
    }));
    expect(rows.settings).toMatchObject({
      maxOpenComplaints: 5,
      lostFoundExpiryDays: 30,
      lendingExpiryDays: 14,
      maxOpenPosts: 5,
      maxNewConversationsPerDay: 10,
    });
    expect(rows.counter.lastNumber).toBe(0);
    expect(rows.template).toMatchObject({
      enabled: true,
      rulesEn: null,
      rulesAr: null,
    });
    const byKey = (p: { key: string }, q: { key: string }) =>
      p.key.localeCompare(q.key);
    expect(
      rows.categories
        .map((c) => ({
          key: c.key,
          nameAr: c.nameAr,
          nameEn: c.nameEn,
          active: c.active,
        }))
        .sort(byKey),
    ).toEqual(
      [...DEFAULT_COMPLAINT_CATEGORIES]
        .sort(byKey)
        .map((c) => ({ ...c, active: true })),
    );
    // Rows of its own: no other compound's.
    const mine = await categories(
      '/neighbours/complaint-categories',
      s.manager,
    );
    expect(
      mine.filter((m) => rows.categories.some((c) => c.id === m.id)),
    ).toEqual([]);
  });

  describe('settings', () => {
    it('the manager reads and changes the limits; the change is audited by value', async () => {
      expect(
        (
          await n
            .http('get', '/neighbours/settings', s.manager.token)
            .expect(200)
        ).body,
      ).toEqual({
        maxOpenComplaints: 5,
        lostFoundExpiryDays: 30,
        lendingExpiryDays: 14,
        maxOpenPosts: 5,
        maxNewConversationsPerDay: 10,
      });
      const res = await n
        .http('patch', '/neighbours/settings', s.manager.token, {
          maxOpenComplaints: 3,
          lendingExpiryDays: 7,
        })
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        maxOpenComplaints: 3,
        lendingExpiryDays: 7,
        lostFoundExpiryDays: 30,
      });
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbours.settings_changed',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].changes).toEqual({
        maxOpenComplaints: { from: 5, to: 3 },
        lendingExpiryDays: { from: 14, to: 7 },
      });
      // Nothing changed: nothing audited.
      await n
        .http('patch', '/neighbours/settings', s.manager.token, {
          maxOpenComplaints: 3,
        })
        .expect(200);
      expect(
        await audit.tenant(s.c.tenantId, {
          action: 'neighbours.settings_changed',
        }),
      ).toHaveLength(1);
    });

    it('a limit outside its range is refused, field by field', async () => {
      const res = await n
        .http('patch', '/neighbours/settings', s.manager.token, {
          maxOpenComplaints: 0,
          lostFoundExpiryDays: 181,
        })
        .expect(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        {
          field: 'maxOpenComplaints',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 50 },
        },
        {
          field: 'lostFoundExpiryDays',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 180 },
        },
      ]);
    });

    it('only who holds neighbours.manage: not a handler, not a resident', async () => {
      for (const who of [s.handler, s.alice]) {
        await n.http('get', '/neighbours/settings', who.token).expect(403);
        await n
          .http('patch', '/neighbours/settings', who.token, { maxOpenPosts: 2 })
          .expect(403);
        await n
          .http('get', '/neighbours/complaint-categories', who.token)
          .expect(403);
        await n
          .http('get', '/neighbours/welcome-template', who.token)
          .expect(403);
      }
    });
  });

  describe('categories', () => {
    it('the manager adds one; residents and handlers are offered it; a duplicate key is refused', async () => {
      const created = (
        await n
          .http('post', '/neighbours/complaint-categories', s.manager.token, {
            key: 'renovation',
            nameAr: 'أعمال تجديد',
            nameEn: 'Renovation works',
          })
          .expect(201)
      ).body as Category;
      expect(created).toMatchObject({ key: 'renovation', active: true });
      for (const who of [s.alice, s.handler])
        expect(
          (await categories('/neighbour-complaint-categories', who)).map(
            (c) => c.key,
          ),
        ).toContain('renovation');
      const duplicate = await n
        .http('post', '/neighbours/complaint-categories', s.manager.token, {
          key: 'renovation',
          nameAr: 'تجديد',
          nameEn: 'Renovation',
        })
        .expect(409);
      expect(duplicate.body).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
        fields: [{ field: 'key', code: 'DUPLICATE_VALUE' }],
      });
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_complaint_category.created',
        targetId: created.id,
      });
      expect(rows).toHaveLength(1);
      // The key by value; the names only as "changed".
      expect(JSON.stringify(rows[0].changes)).not.toContain('Renovation');
      expect(rows[0].changes).toMatchObject({
        key: { from: null, to: 'renovation' },
        nameEn: { changed: true },
      });
    });

    it('a retired category is no longer offered, and no new complaint is filed under it', async () => {
      const smoking = (
        await categories('/neighbours/complaint-categories', s.manager)
      ).find((c) => c.key === 'smoking')!;
      await n
        .http(
          'patch',
          `/neighbours/complaint-categories/${smoking.id}`,
          s.manager.token,
          { active: false },
        )
        .expect(200);
      expect(
        (await categories('/neighbour-complaint-categories', s.alice)).map(
          (c) => c.key,
        ),
      ).not.toContain('smoking');
      // The manager still lists it, retired.
      expect(
        (await categories('/neighbours/complaint-categories', s.manager)).find(
          (c) => c.key === 'smoking',
        ),
      ).toMatchObject({ active: false });
      const res = await n
        .complainRaw(s.c, s.alice, s.homeB.code, { categoryId: smoking.id })
        .expect(400);
      expect((res.body as { fields: unknown[] }).fields).toEqual([
        { field: 'categoryId', code: 'CATEGORY_NOT_AVAILABLE' },
      ]);
    });

    it('another compound’s category is not found', async () => {
      const other = await n.setUp();
      const theirs = (
        await categories('/neighbours/complaint-categories', other.manager)
      )[0];
      const res = await n
        .http(
          'patch',
          `/neighbours/complaint-categories/${theirs.id}`,
          s.manager.token,
          { active: false },
        )
        .expect(404);
      expect(res.body).toMatchObject({
        code: 'NEIGHBOUR_COMPLAINT_CATEGORY_NOT_FOUND',
      });
    });
  });
});
