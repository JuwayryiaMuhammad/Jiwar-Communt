import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { fileHelpers } from '../setup/files';
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
const CREATED = ['createdAt', 'id', 'number', 'priority', 'status'];
const CATEGORY_REF = [
  'category.id',
  'category.key',
  'category.nameAr',
  'category.nameEn',
];
const PHOTO = ['cycle', 'expiresAt', 'id', 'kind', 'url'];
/** A detail's key set once it has a photo. */
const withPhotos = (keys: string[]) =>
  [...keys, ...PHOTO.map((k) => `photos[].${k}`)].sort();
const RESIDENT = [
  'category',
  ...CATEGORY_REF,
  'commonArea',
  'confirmationStatus',
  'createdAt',
  'holdReason',
  'id',
  'number',
  'priority',
  'reportedByMe',
  'status',
  'unitCode',
  'unitId',
  'updatedAt',
].sort();
const RESIDENT_DETAIL = [
  ...RESIDENT,
  'autoCloseAt',
  'closedAt',
  'completedAt',
  'cycle',
  'description',
  'onBehalf',
  'photos',
  'reopenUntil',
  'reporter',
  'reporter.firstName',
  'reporter.id',
  'technician',
].sort();
const DISPATCH = [
  'category',
  ...CATEGORY_REF,
  'commonArea',
  'confirmationStatus',
  'createdAt',
  'cycle',
  'holdReason',
  'id',
  'number',
  'priority',
  'rejectionCount',
  'status',
  'technician',
  'unit',
  'unit.code',
  'unit.id',
  'updatedAt',
].sort();
const DISPATCH_DETAIL = [
  ...DISPATCH,
  'cancelledAt',
  'closedAt',
  'completedAt',
  'createdBy',
  'createdBy.fullName',
  'createdBy.id',
  'description',
  'feedback',
  'photos',
  'reporter',
  'reporter.fullName',
  'reporter.id',
].sort();

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

  const open = (token: string, body: object) =>
    call(w, 'POST', '/tickets', {
      token,
      body: { categoryId: w.aCategoryId, description: 'It leaks', ...body },
    });
  const ticketIds = async (path: string, token: string) =>
    (
      (await call(w, 'GET', path, { token }).expect(200)).body as {
        data: { id: string }[];
      }
    ).data.map((t) => t.id);

  describe('tickets — opening and reading', () => {
    it('a resident opens a ticket on their unit and reads it; the number counts up', async () => {
      const photo = await fileHelpers(h).ready(
        w.a.tokens.owner,
        'ticket_photo',
      );
      const created = await open(w.a.tokens.owner, {
        unitId: w.a.homeUnitId,
        photoFileIds: [photo],
      }).expect(201);
      expect(keyPaths(created.body)).toEqual(CREATED);
      const t = created.body as { id: string; number: string };
      expect(t.number).toMatch(/^MT-\d{6}$/);
      expect(created.body).toMatchObject({ status: 'new', priority: 'normal' });
      const next = await open(w.a.tokens.owner, {
        unitId: w.a.homeUnitId,
      }).expect(201);
      expect(Number((next.body as { number: string }).number.slice(3))).toBe(
        Number(t.number.slice(3)) + 1,
      );

      const list = await call(w, 'GET', '/tickets', {
        token: w.a.tokens.owner,
      }).expect(200);
      expect(keyPaths(list.body)).toEqual(listKeys(RESIDENT));
      const detail = await call(w, 'GET', `/tickets/${t.id}`, {
        token: w.a.tokens.owner,
      }).expect(200);
      expect(keyPaths(detail.body)).toEqual(withPhotos(RESIDENT_DETAIL));
      expect(detail.headers['cache-control']).toBe('no-store');
      expect(detail.body).toMatchObject({
        id: t.id,
        unitId: w.a.homeUnitId,
        commonArea: null,
        reportedByMe: true,
        onBehalf: false,
        technician: null,
        cycle: 1,
        description: 'It leaks',
        photos: [{ kind: 'report', cycle: 1 }],
      });
      // The photo moved to the ticket: its uploader can no longer reach it.
      await call(w, 'GET', `/files/${photo}`, {
        token: w.a.tokens.owner,
      }).expect(404);
    });

    it('capabilities decide: a landlord and a family member without `tickets` are refused', async () => {
      const landlord = await open(w.a.tokens.landlord, {
        unitId: w.a.rentedUnitId,
      });
      expect(code(landlord)).toEqual({
        status: 403,
        code: 'TICKETS_NOT_ALLOWED',
      });
      // The tenant of that unit may.
      await open(w.a.tokens.tenant, { unitId: w.a.rentedUnitId }).expect(201);
      // A unit the caller has no place in is not found.
      const elsewhere = await open(w.a.tokens.tenant, {
        unitId: w.a.homeUnitId,
      });
      expect(code(elsewhere)).toEqual({ status: 404, code: 'UNIT_NOT_FOUND' });

      // A family member whose `tickets` permission was revoked.
      const family = await w.helpers.joinFamily(w.a, w.a.homeUnitId, {
        id: w.a.ids.owner,
      });
      await w.helpers.as(w.a, { id: w.a.ids.owner, type: 'resident' }, () =>
        h.moduleRef
          .get(MemberPermissionsService)
          .revoke(family.memberId, 'tickets', {
            code: 'no_longer_needed',
            text: 'Not any more',
          }),
      );
      const token = await w.tokenFor(w.a, family.id, 'family');
      const refused = await open(token, { unitId: w.a.homeUnitId });
      expect(code(refused)).toEqual({
        status: 403,
        code: 'TICKETS_NOT_ALLOWED',
      });
      // …and they hold `tickets` on no unit, so no common area either.
      const area = await open(token, { commonArea: 'Lobby' });
      expect(code(area)).toEqual({ status: 403, code: 'TICKETS_NOT_ALLOWED' });
    });

    it('a common area: anyone holding `tickets` on a unit, never a landlord alone, never with a unit too', async () => {
      const created = await open(w.a.tokens.family, {
        commonArea: '  Pool, north side ',
      }).expect(201);
      const detail = await call(
        w,
        'GET',
        `/tickets/${(created.body as { id: string }).id}`,
        { token: w.a.tokens.family },
      ).expect(200);
      expect(detail.body).toMatchObject({
        unitId: null,
        unitCode: null,
        commonArea: 'Pool, north side',
      });
      const landlord = await open(w.a.tokens.landlord, { commonArea: 'Gym' });
      expect(code(landlord)).toEqual({
        status: 403,
        code: 'TICKETS_NOT_ALLOWED',
      });
      const both = await open(w.a.tokens.owner, {
        unitId: w.a.homeUnitId,
        commonArea: 'Gym',
      });
      expect(err(both).fields).toEqual([
        { field: 'commonArea', code: 'FIELD_NOT_ALLOWED' },
      ]);
      const neither = await open(w.a.tokens.owner, {});
      expect(err(neither).fields).toEqual([
        { field: 'unitId', code: 'FIELD_REQUIRED' },
      ]);
      const blank = await open(w.a.tokens.owner, { commonArea: '   ' });
      expect(err(blank).fields).toEqual([
        {
          field: 'commonArea',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 120 },
        },
      ]);
    });

    it('a category that is retired, or not for common areas, is refused', async () => {
      const key = `roof_${Date.now().toString(36)}`;
      const category = (
        await call(w, 'POST', '/maintenance/categories', {
          token: manager(),
          body: {
            key,
            nameAr: 'سطح',
            nameEn: 'Roof',
            commonAreaAllowed: false,
            defaultPriority: 'urgent',
          },
        }).expect(201)
      ).body as { id: string };
      const notHere = await open(w.a.tokens.owner, {
        commonArea: 'Roof',
        categoryId: category.id,
      });
      expect(err(notHere).fields).toEqual([
        { field: 'categoryId', code: 'CATEGORY_NOT_FOR_COMMON_AREA' },
      ]);
      // On a unit it is fine, at the category's default priority.
      const onUnit = await open(w.a.tokens.owner, {
        unitId: w.a.homeUnitId,
        categoryId: category.id,
      }).expect(201);
      expect(onUnit.body).toMatchObject({ priority: 'urgent' });
      await call(w, 'PATCH', `/maintenance/categories/${category.id}`, {
        token: manager(),
        body: { active: false },
      }).expect(200);
      const retired = await open(w.a.tokens.owner, {
        unitId: w.a.homeUnitId,
        categoryId: category.id,
      });
      expect(code(retired)).toEqual({
        status: 404,
        code: 'TICKET_CATEGORY_NOT_FOUND',
      });
    });

    it('who sees a ticket: its reporter and creator, the unit’s primary, dispatch — nobody else', async () => {
      const byFamily = (
        await open(w.a.tokens.family, { unitId: w.a.homeUnitId }).expect(201)
      ).body as { id: string };
      // The primary of the unit sees the family member's ticket.
      expect(await ticketIds('/tickets', w.a.tokens.owner)).toContain(
        byFamily.id,
      );
      const asOwner = await call(w, 'GET', `/tickets/${byFamily.id}`, {
        token: w.a.tokens.owner,
      }).expect(200);
      expect(asOwner.body).toMatchObject({ reportedByMe: false });
      // A tenant of another unit, the landlord: not found.
      for (const token of [w.a.tokens.tenant, w.a.tokens.landlord]) {
        expect(await ticketIds('/tickets', token)).not.toContain(byFamily.id);
        const res = await call(w, 'GET', `/tickets/${byFamily.id}`, { token });
        expect(code(res)).toEqual({ status: 404, code: 'TICKET_NOT_FOUND' });
      }
      // Dispatch sees everything, with full names.
      const list = await call(w, 'GET', '/maintenance/tickets', {
        token: manager(),
        query: { unassigned: 'true', status: 'new' },
      }).expect(200);
      expect(keyPaths(list.body)).toEqual(listKeys(DISPATCH));
      expect(
        (list.body as { data: { id: string }[] }).data.map((t) => t.id),
      ).toContain(byFamily.id);
      const detail = await call(
        w,
        'GET',
        `/maintenance/tickets/${byFamily.id}`,
        {
          token: manager(),
        },
      ).expect(200);
      expect(keyPaths(detail.body)).toEqual(DISPATCH_DETAIL);
      expect(detail.headers['cache-control']).toBe('no-store');
      const history = await call(
        w,
        'GET',
        `/maintenance/tickets/${byFamily.id}/history`,
        { token: manager() },
      ).expect(200);
      expect(history.body).toMatchObject({
        data: [
          {
            fromStatus: null,
            toStatus: 'new',
            actor: { id: w.a.ids.family },
            reasonCode: null,
            cycle: 1,
          },
        ],
        nextCursor: null,
      });
      const assignments = await call(
        w,
        'GET',
        `/maintenance/tickets/${byFamily.id}/assignments`,
        { token: manager() },
      ).expect(200);
      expect(assignments.body).toEqual({ data: [], nextCursor: null });
    });

    it('report photos: only the reporter or creator, up to the compound’s limit', async () => {
      const t = (
        await open(w.a.tokens.family, { unitId: w.a.homeUnitId }).expect(201)
      ).body as { id: string };
      const add = async (token: string) =>
        call(w, 'POST', `/tickets/${t.id}/photos`, {
          token,
          body: { fileId: await fileHelpers(h).ready(token, 'ticket_photo') },
        });
      // The primary sees it but did not report it.
      const primary = await add(w.a.tokens.owner);
      expect(code(primary)).toEqual({
        status: 403,
        code: 'TICKET_ACTION_NOT_ALLOWED',
      });
      await call(w, 'PATCH', '/maintenance/settings', {
        token: manager(),
        body: { maxReportPhotos: 2 },
      }).expect(200);
      try {
        // Not one of the caller's files: one answer.
        const foreign = await call(w, 'POST', `/tickets/${t.id}/photos`, {
          token: w.a.tokens.family,
          body: { fileId: w.bFileId },
        });
        expect(err(foreign).fields).toEqual([
          { field: 'fileId', code: 'FILE_NOT_AVAILABLE' },
        ]);
        const first = await add(w.a.tokens.family);
        expect(first.status).toBe(201);
        expect(keyPaths(first.body)).toEqual([
          'createdAt',
          'cycle',
          'id',
          'kind',
        ]);
        await add(w.a.tokens.family).then((r) => expect(r.status).toBe(201));
        const third = await add(w.a.tokens.family);
        expect(code(third)).toEqual({
          status: 409,
          code: 'TICKET_PHOTO_LIMIT_REACHED',
        });
        expect(err(third).params).toEqual({ max: 2 });
      } finally {
        await call(w, 'PATCH', '/maintenance/settings', {
          token: manager(),
          body: { maxReportPhotos: 5 },
        }).expect(200);
      }
    });

    it('dispatch opens a ticket for a resident: the resident is told, and it is audited', async () => {
      const created = await call(w, 'POST', '/maintenance/tickets', {
        token: manager(),
        body: {
          unitId: w.a.rentedUnitId,
          categoryId: w.aCategoryId,
          description: 'Called the office',
          reporterAccountId: w.a.ids.tenant,
        },
      }).expect(201);
      expect(keyPaths(created.body)).toEqual(CREATED);
      const id = (created.body as { id: string }).id;
      const asTenant = await call(w, 'GET', `/tickets/${id}`, {
        token: w.a.tokens.tenant,
      }).expect(200);
      expect(asTenant.body).toMatchObject({
        reportedByMe: true,
        onBehalf: true,
        reporter: { id: w.a.ids.tenant },
      });
      expect(JSON.stringify(asTenant.body)).not.toContain(w.a.ids.manager);
      const inbox = await call(w, 'GET', '/me/notifications', {
        token: w.a.tokens.tenant,
      }).expect(200);
      expect(
        (inbox.body as { data: { kind: string; targetId: string }[] }).data,
      ).toContainEqual(
        expect.objectContaining({
          kind: 'ticket.opened_on_behalf',
          targetId: id,
        }),
      );
      // The landlord cannot report there; a guard is no reporter at all.
      for (const reporter of [w.a.ids.landlord, w.a.ids.guard]) {
        const res = await call(w, 'POST', '/maintenance/tickets', {
          token: manager(),
          body: {
            unitId: w.a.rentedUnitId,
            categoryId: w.aCategoryId,
            description: 'x',
            reporterAccountId: reporter,
          },
        });
        expect(err(res).fields).toEqual([
          { field: 'reporterAccountId', code: 'REPORTER_NOT_ELIGIBLE' },
        ]);
      }
    });

    it('an emergency tells every dispatcher, critically', async () => {
      const created = await open(w.a.tokens.owner, {
        unitId: w.a.homeUnitId,
        priority: 'emergency',
      }).expect(201);
      const id = (created.body as { id: string }).id;
      const inbox = await call(w, 'GET', '/me/notifications', {
        token: manager(),
      }).expect(200);
      expect(
        (
          inbox.body as {
            data: {
              kind: string;
              priority: string;
              targetId: string;
              params: object;
            }[];
          }
        ).data.find((n) => n.targetId === id),
      ).toMatchObject({
        kind: 'ticket.emergency',
        priority: 'critical',
        params: {
          ticketNumber: (created.body as { number: string }).number,
          categoryKey: 'plumbing',
        },
      });
    });
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
