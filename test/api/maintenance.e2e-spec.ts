import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const OPTION = [
  'commonAreaAllowed',
  'defaultPriority',
  'id',
  'key',
  'nameAr',
  'nameEn',
];
const CATEGORY = [...OPTION, 'active', 'createdAt', 'updatedAt'].sort();
const SETTINGS = ['autoCloseHours', 'maxReportPhotos', 'reopenDays'];

describe('API v0 — maintenance (ADR 0032)', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;
  const code = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });

  describe('categories and settings', () => {
    it('the manager lists, adds, renames and retires categories; residents see the active ones', async () => {
      const list = await call(w, 'GET', '/maintenance/categories', {
        token: manager(),
      }).expect(200);
      expect(keyPaths(list.body)).toEqual(listKeys(CATEGORY));
      const keys = (list.body as { data: { key: string }[] }).data.map(
        (c) => c.key,
      );
      expect(keys).toEqual(
        expect.arrayContaining([
          'ac',
          'carpentry',
          'electrical',
          'general',
          'plumbing',
        ]),
      );

      const key = `pool_${Date.now().toString(36)}`;
      const created = await call(w, 'POST', '/maintenance/categories', {
        token: manager(),
        body: { key, nameAr: 'حمام السباحة', nameEn: 'Pool' },
      }).expect(201);
      expect(keyPaths(created.body)).toEqual(CATEGORY);
      expect(created.body).toMatchObject({
        key,
        defaultPriority: 'normal',
        commonAreaAllowed: true,
        active: true,
      });
      const id = (created.body as { id: string }).id;

      const dup = await call(w, 'POST', '/maintenance/categories', {
        token: manager(),
        body: { key, nameAr: 'x', nameEn: 'x' },
      });
      expect(code(dup)).toEqual({ status: 409, code: 'DUPLICATE_RESOURCE' });
      expect(err(dup).fields).toEqual([
        { field: 'key', code: 'DUPLICATE_VALUE' },
      ]);
      // The key never changes.
      const rekey = await call(w, 'PATCH', `/maintenance/categories/${id}`, {
        token: manager(),
        body: { key: 'other' },
      });
      expect(code(rekey)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });

      const options = async (token: string) =>
        (
          (await call(w, 'GET', '/ticket-categories', { token }).expect(200))
            .body as { data: { id: string }[] }
        ).data.map((c) => c.id);
      const opts = await call(w, 'GET', '/ticket-categories', {
        token: w.a.tokens.family,
      }).expect(200);
      expect(keyPaths(opts.body)).toEqual(listKeys(OPTION));
      expect(await options(w.a.tokens.owner)).toContain(id);
      // The manager dispatches too, so they see the options.
      expect(await options(manager())).toContain(id);

      const retired = await call(w, 'PATCH', `/maintenance/categories/${id}`, {
        token: manager(),
        body: { nameEn: 'Swimming pool', active: false },
      }).expect(200);
      expect(retired.body).toMatchObject({
        key,
        nameEn: 'Swimming pool',
        active: false,
      });
      expect(await options(w.a.tokens.owner)).not.toContain(id);
    });

    it('the manager reads and changes the settings', async () => {
      const got = await call(w, 'GET', '/maintenance/settings', {
        token: manager(),
      }).expect(200);
      expect(keyPaths(got.body)).toEqual(SETTINGS);
      expect(got.body).toEqual({
        autoCloseHours: 72,
        reopenDays: 7,
        maxReportPhotos: 5,
      });
      const patched = await call(w, 'PATCH', '/maintenance/settings', {
        token: manager(),
        body: { autoCloseHours: 48 },
      }).expect(200);
      expect(patched.body).toEqual({
        autoCloseHours: 48,
        reopenDays: 7,
        maxReportPhotos: 5,
      });
      await call(w, 'PATCH', '/maintenance/settings', {
        token: manager(),
        body: { autoCloseHours: 72 },
      }).expect(200);
    });
  });
});
