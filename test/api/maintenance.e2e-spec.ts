import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { AUTO_CLOSE_SWEEP } from '../../src/maintenance/tickets/confirmation.service';
import { fileHelpers } from '../setup/files';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
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
const TECHNICIAN = [
  'assignedAt',
  'category',
  ...CATEGORY_REF,
  'commonArea',
  'createdAt',
  'holdReason',
  'id',
  'number',
  'priority',
  'status',
  'unitCode',
].sort();
const TECHNICIAN_DETAIL = [
  ...TECHNICIAN,
  'confirmationStatus',
  'cycle',
  'description',
  'photos',
  'rejectionCount',
  'reporterFirstName',
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

  /** A staff account with a role, created over HTTP, and its token. */
  async function staff(roleKey: string) {
    const res = await call(w, 'POST', '/accounts', {
      token: manager(),
      body: {
        type: 'staff',
        roleKey,
        fullName: `Tech ${uniqueSuffix()} Second`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail(roleKey),
      },
    }).expect(201);
    const id = (res.body as { id: string }).id;
    return { id, token: await w.tokenFor(w.a, id, 'staff') };
  }

  /** A fresh ticket on the owner's home, assigned to `technicianId`. */
  async function assigned(technicianId: string, token = manager()) {
    const t = (
      await open(w.a.tokens.owner, { unitId: w.a.homeUnitId }).expect(201)
    ).body as { id: string; number: string };
    await call(w, 'POST', `/maintenance/tickets/${t.id}/assign`, {
      token,
      body: { technicianId },
    }).expect(204);
    return t;
  }

  const kinds = async (token: string, id: string) =>
    (
      (await call(w, 'GET', '/me/notifications', { token }).expect(200))
        .body as { data: { kind: string; targetId: string }[] }
    ).data
      .filter((n) => n.targetId === id)
      .map((n) => n.kind);

  describe('assignment and the technician’s workflow', () => {
    it('assign, start, hold, resume, complete: the reporter follows along', async () => {
      const tech = w.a.tokens.technician;
      const t = await assigned(w.a.ids.technician);
      expect(await kinds(tech, t.id)).toEqual(['ticket.assigned']);
      expect(await ticketIds('/technician/tickets', tech)).toContain(t.id);
      const list = await call(w, 'GET', '/technician/tickets', {
        token: tech,
      }).expect(200);
      expect(keyPaths(list.body)).toEqual(listKeys(TECHNICIAN));
      const detail = await call(w, 'GET', `/technician/tickets/${t.id}`, {
        token: tech,
      }).expect(200);
      expect(keyPaths(detail.body)).toEqual(TECHNICIAN_DETAIL);
      expect(detail.headers['cache-control']).toBe('no-store');
      const firstName = (
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.account.findUniqueOrThrow({
            where: { id: w.a.ids.owner },
          }),
        )
      ).fullName!.split(' ')[0];
      expect(detail.body).toMatchObject({
        status: 'assigned',
        reporterFirstName: firstName,
        unitCode: expect.any(String) as string,
      });

      const act = (verb: string, body: object = {}) =>
        call(w, 'POST', `/technician/tickets/${t.id}/${verb}`, {
          token: tech,
          body,
        });
      // Not before it starts.
      expect(code(await act('complete'))).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
      });
      await act('start').expect(204);
      await act('hold', { holdReason: 'awaiting_parts' }).expect(204);
      const held = await call(w, 'GET', `/tickets/${t.id}`, {
        token: w.a.tokens.owner,
      }).expect(200);
      expect(held.body).toMatchObject({
        status: 'on_hold',
        holdReason: 'awaiting_parts',
        technician: { id: w.a.ids.technician },
      });
      await act('resume').expect(204);
      await act('complete').expect(204);
      const done = await call(w, 'GET', `/tickets/${t.id}`, {
        token: w.a.tokens.owner,
      }).expect(200);
      expect(done.body).toMatchObject({
        status: 'completed',
        confirmationStatus: 'pending',
        holdReason: null,
        autoCloseAt: expect.any(String) as string,
      });
      expect(await kinds(w.a.tokens.owner, t.id)).toEqual(
        expect.arrayContaining(['ticket.status_changed', 'ticket.completed']),
      );

      const history = await call(
        w,
        'GET',
        `/maintenance/tickets/${t.id}/history`,
        { token: manager() },
      ).expect(200);
      expect(
        (
          history.body as {
            data: {
              fromStatus: string;
              toStatus: string;
              reasonCode: string;
            }[];
          }
        ).data.map((r) => [r.fromStatus, r.toStatus, r.reasonCode]),
      ).toEqual([
        [null, 'new', null],
        ['new', 'assigned', null],
        ['assigned', 'in_progress', null],
        ['in_progress', 'on_hold', 'awaiting_parts'],
        ['on_hold', 'in_progress', null],
        ['in_progress', 'completed', null],
      ]);
      const trail = await call(
        w,
        'GET',
        `/maintenance/tickets/${t.id}/assignments`,
        { token: manager() },
      ).expect(200);
      expect(trail.body).toMatchObject({
        data: [
          {
            type: 'manual',
            from: null,
            to: { id: w.a.ids.technician },
            by: { id: w.a.ids.manager },
            reasonCode: null,
            cycle: 1,
          },
        ],
      });
    });

    it('two dispatchers assign the same ticket: one wins', async () => {
      const t = (
        await open(w.a.tokens.owner, { unitId: w.a.homeUnitId }).expect(201)
      ).body as { id: string };
      const supervisor = await staff('maintenance_supervisor');
      const other = await staff('technician');
      const results = await Promise.all([
        call(w, 'POST', `/maintenance/tickets/${t.id}/assign`, {
          token: manager(),
          body: { technicianId: w.a.ids.technician },
        }),
        call(w, 'POST', `/maintenance/tickets/${t.id}/assign`, {
          token: supervisor.token,
          body: { technicianId: other.id },
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(code(results.find((r) => r.status === 409)!)).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
      });
      const trail = await call(
        w,
        'GET',
        `/maintenance/tickets/${t.id}/assignments`,
        { token: manager() },
      ).expect(200);
      expect((trail.body as { data: unknown[] }).data).toHaveLength(1);
    });

    it('only a technician: a guard, a manager, an unknown or foreign id is TECHNICIAN_NOT_FOUND', async () => {
      const t = (
        await open(w.a.tokens.owner, { unitId: w.a.homeUnitId }).expect(201)
      ).body as { id: string };
      for (const technicianId of [
        w.a.ids.guard,
        w.a.ids.manager,
        w.b.ids.technician,
        '01900000-0000-7000-8000-000000000000',
      ]) {
        const res = await call(
          w,
          'POST',
          `/maintenance/tickets/${t.id}/assign`,
          {
            token: manager(),
            body: { technicianId },
          },
        );
        expect(code(res)).toEqual({
          status: 404,
          code: 'TECHNICIAN_NOT_FOUND',
        });
      }
      const list = await call(w, 'GET', '/maintenance/technicians', {
        token: manager(),
      }).expect(200);
      expect(keyPaths(list.body)).toEqual(
        listKeys(['fullName', 'id', 'openTickets']),
      );
      const ids = (list.body as { data: { id: string }[] }).data.map(
        (x) => x.id,
      );
      expect(ids).toContain(w.a.ids.technician);
      expect(ids).not.toContain(w.a.ids.guard);
    });

    it('a decline returns the ticket to the queue: the technician loses it, dispatch is told', async () => {
      const t = await assigned(w.a.ids.technician);
      const decline = (body: object) =>
        call(w, 'POST', `/technician/tickets/${t.id}/decline`, {
          token: w.a.tokens.technician,
          body,
        });
      expect(code(await decline({}))).toEqual({
        status: 400,
        code: 'REASON_REQUIRED',
      });
      expect(err(await decline({ reasonCode: 'tired' })).fields).toEqual([
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: {
            allowed: [
              'not_my_specialty',
              'unavailable',
              'needs_parts_or_tools',
              'unsafe',
              'other',
            ],
          },
        },
      ]);
      await decline({ reasonCode: 'not_my_specialty' }).expect(204);
      const gone = await call(w, 'GET', `/technician/tickets/${t.id}`, {
        token: w.a.tokens.technician,
      });
      expect(code(gone)).toEqual({ status: 404, code: 'TICKET_NOT_FOUND' });
      expect(
        await ticketIds('/technician/tickets', w.a.tokens.technician),
      ).not.toContain(t.id);
      const queued = await call(w, 'GET', `/maintenance/tickets/${t.id}`, {
        token: manager(),
      }).expect(200);
      expect(queued.body).toMatchObject({ status: 'new', technician: null });
      expect(await kinds(manager(), t.id)).toContain('ticket.declined');
      const trail = await call(
        w,
        'GET',
        `/maintenance/tickets/${t.id}/assignments`,
        { token: manager() },
      ).expect(200);
      expect((trail.body as { data: object[] }).data[1]).toMatchObject({
        type: 'declined',
        from: { id: w.a.ids.technician },
        to: null,
        by: { id: w.a.ids.technician },
        reasonCode: 'not_my_specialty',
      });
      // Once started, it is the dispatcher's to reassign.
      const started = await assigned(w.a.ids.technician);
      await call(w, 'POST', `/technician/tickets/${started.id}/start`, {
        token: w.a.tokens.technician,
      }).expect(204);
      const late = await call(
        w,
        'POST',
        `/technician/tickets/${started.id}/decline`,
        { token: w.a.tokens.technician, body: { reasonCode: 'unavailable' } },
      );
      expect(code(late)).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
      });
    });

    it('a reassignment moves the ticket: the old technician loses it and is told', async () => {
      const other = await staff('technician');
      const t = await assigned(w.a.ids.technician);
      await call(w, 'POST', `/technician/tickets/${t.id}/start`, {
        token: w.a.tokens.technician,
      }).expect(204);
      const reassign = (body: object) =>
        call(w, 'POST', `/maintenance/tickets/${t.id}/reassign`, {
          token: manager(),
          body,
        });
      expect(code(await reassign({ technicianId: other.id }))).toEqual({
        status: 400,
        code: 'REASON_REQUIRED',
      });
      expect(
        err(
          await reassign({
            technicianId: w.a.ids.technician,
            reasonCode: 'workload',
          }),
        ).fields,
      ).toEqual([{ field: 'technicianId', code: 'SAME_AS_CURRENT' }]);
      await reassign({ technicianId: other.id, reasonCode: 'workload' }).expect(
        204,
      );
      expect(
        code(
          await call(w, 'GET', `/technician/tickets/${t.id}`, {
            token: w.a.tokens.technician,
          }),
        ),
      ).toEqual({ status: 404, code: 'TICKET_NOT_FOUND' });
      // Its writes are refused the same way.
      expect(
        code(
          await call(w, 'POST', `/technician/tickets/${t.id}/complete`, {
            token: w.a.tokens.technician,
          }),
        ),
      ).toEqual({ status: 404, code: 'TICKET_NOT_FOUND' });
      expect(await kinds(w.a.tokens.technician, t.id)).toContain(
        'ticket.unassigned',
      );
      const now = await call(w, 'GET', `/technician/tickets/${t.id}`, {
        token: other.token,
      }).expect(200);
      expect(now.body).toMatchObject({ status: 'assigned' });
    });

    it('a priority change takes a reason, is audited, and an emergency alerts dispatch', async () => {
      const t = await assigned(w.a.ids.technician);
      const supervisor = await staff('maintenance_supervisor');
      await call(w, 'POST', `/maintenance/tickets/${t.id}/priority`, {
        token: supervisor.token,
        body: { priority: 'emergency', reasonCode: 'safety_risk' },
      }).expect(204);
      expect(await kinds(manager(), t.id)).toContain('ticket.emergency');
      expect(await kinds(w.a.tokens.technician, t.id)).toContain(
        'ticket.priority_changed',
      );
      const same = await call(
        w,
        'POST',
        `/maintenance/tickets/${t.id}/priority`,
        {
          token: manager(),
          body: { priority: 'emergency', reasonCode: 'reassessed' },
        },
      );
      expect(err(same).fields).toEqual([
        { field: 'priority', code: 'SAME_AS_CURRENT' },
      ]);
    });

    it('before and after photos: the technician, while working, ten per cycle', async () => {
      const t = await assigned(w.a.ids.technician);
      const add = async (kind: string) =>
        call(w, 'POST', `/technician/tickets/${t.id}/photos`, {
          token: w.a.tokens.technician,
          body: {
            fileId: await fileHelpers(h).ready(
              w.a.tokens.technician,
              'ticket_photo',
            ),
            kind,
          },
        });
      expect(code(await add('before'))).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
      });
      await call(w, 'POST', `/technician/tickets/${t.id}/start`, {
        token: w.a.tokens.technician,
      }).expect(204);
      for (let i = 0; i < 10; i++)
        expect((await add(i < 5 ? 'before' : 'after')).status).toBe(201);
      const eleventh = await add('after');
      expect(code(eleventh)).toEqual({
        status: 409,
        code: 'TICKET_PHOTO_LIMIT_REACHED',
      });
      const seen = await call(w, 'GET', `/tickets/${t.id}`, {
        token: w.a.tokens.owner,
      }).expect(200);
      expect((seen.body as { photos: unknown[] }).photos).toHaveLength(10);
    });

    it('a deactivated technician’s tickets go back to the queue', async () => {
      const gone = await staff('technician');
      const a = await assigned(gone.id);
      const b = await assigned(gone.id);
      await call(w, 'POST', `/technician/tickets/${b.id}/start`, {
        token: gone.token,
      }).expect(204);
      await call(w, 'PATCH', `/accounts/${gone.id}/status`, {
        token: manager(),
        body: { status: 'inactive' },
      }).expect(200);
      for (const t of [a, b]) {
        const res = await call(w, 'GET', `/maintenance/tickets/${t.id}`, {
          token: manager(),
        }).expect(200);
        expect(res.body).toMatchObject({ status: 'new', technician: null });
        const trail = await call(
          w,
          'GET',
          `/maintenance/tickets/${t.id}/assignments`,
          { token: manager() },
        ).expect(200);
        expect((trail.body as { data: object[] }).data.at(-1)).toMatchObject({
          type: 'released',
          from: { id: gone.id },
          to: null,
          by: null,
          reasonCode: 'technician_unavailable',
        });
        expect(await kinds(manager(), t.id)).toContain(
          'ticket.technician_unavailable',
        );
      }
      // And they can no longer be assigned.
      const again = await call(
        w,
        'POST',
        `/maintenance/tickets/${a.id}/assign`,
        { token: manager(), body: { technicianId: gone.id } },
      );
      expect(code(again)).toEqual({
        status: 404,
        code: 'TECHNICIAN_NOT_FOUND',
      });
    });
  });

  describe('confirmation, rejection, reopen, cancel', () => {
    const sweep = (now = new Date()) =>
      h.moduleRef.get(SweepRunner).run(AUTO_CLOSE_SWEEP, now);
    const work = (id: string, token = w.a.tokens.technician) => ({
      start: () =>
        call(w, 'POST', `/technician/tickets/${id}/start`, { token }).expect(
          204,
        ),
      complete: () =>
        call(w, 'POST', `/technician/tickets/${id}/complete`, {
          token,
        }).expect(204),
    });
    const as = (token: string, id: string, verb: string, body: object) =>
      call(w, 'POST', `/tickets/${id}/${verb}`, { token, body });
    const dispatchView = async (id: string) =>
      (
        await call(w, 'GET', `/maintenance/tickets/${id}`, {
          token: manager(),
        }).expect(200)
      ).body as Record<string, unknown>;
    /** Assigned, started and completed by the World's technician. */
    async function completed() {
      const t = await assigned(w.a.ids.technician);
      await work(t.id).start();
      await work(t.id).complete();
      return t;
    }
    const setTicket = (id: string, data: object) =>
      w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.ticket.update({ where: { id }, data }),
      );

    it('confirm: closed, rated, the comment for dispatch only', async () => {
      const t = await completed();
      // The unit's primary did report it here; a family member did not.
      const notParty = await as(w.a.tokens.family, t.id, 'confirm', {
        rating: 5,
      });
      expect(code(notParty)).toEqual({ status: 404, code: 'TICKET_NOT_FOUND' });
      await as(w.a.tokens.owner, t.id, 'confirm', {
        rating: 4,
        comment: 'Quick and clean',
      }).expect(204);
      const seen = await call(w, 'GET', `/tickets/${t.id}`, {
        token: w.a.tokens.owner,
      }).expect(200);
      expect(seen.body).toMatchObject({
        status: 'closed',
        confirmationStatus: 'confirmed',
        autoCloseAt: null,
        reopenUntil: expect.any(String) as string,
      });
      expect(await dispatchView(t.id)).toMatchObject({
        feedback: [
          {
            cycle: 1,
            kind: 'confirmed',
            rating: 4,
            reasonCode: null,
            comment: 'Quick and clean',
            author: { id: w.a.ids.owner },
          },
        ],
      });
      const again = await as(w.a.tokens.owner, t.id, 'confirm', { rating: 5 });
      expect(code(again)).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
      });
    });

    it('the first rejection goes back to the same technician; the second to the queue, escalated', async () => {
      const t = await completed();
      const reject = (code: string, reason: string) =>
        as(w.a.tokens.owner, t.id, 'reject', { reasonCode: code, reason });
      expect(code(await reject('', ''))).toEqual({
        status: 400,
        code: 'REASON_REQUIRED',
      });
      await reject('not_fixed', 'Still dripping under the sink').expect(204);
      let view = await dispatchView(t.id);
      expect(view).toMatchObject({
        status: 'assigned',
        technician: { id: w.a.ids.technician },
        confirmationStatus: 'rejected',
        cycle: 2,
        rejectionCount: 1,
      });
      expect(await kinds(manager(), t.id)).toContain('ticket.rejected');
      expect(await kinds(w.a.tokens.technician, t.id)).toContain(
        'ticket.rejected',
      );
      // The note reached the technician through the thread, not a field.
      const tech = await call(w, 'GET', `/technician/tickets/${t.id}`, {
        token: w.a.tokens.technician,
      }).expect(200);
      expect(tech.body).toMatchObject({ cycle: 2, rejectionCount: 1 });
      expect(JSON.stringify(tech.body)).not.toContain('Still dripping');
      const notes = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.ticketMessage.findMany({
          where: { ticketId: t.id },
        }),
      );
      expect(notes).toMatchObject([
        {
          senderId: w.a.ids.owner,
          body: 'Still dripping under the sink',
          internal: false,
        },
      ]);

      await work(t.id).start();
      await work(t.id).complete();
      await reject('poor_quality', 'Worse now').expect(204);
      view = await dispatchView(t.id);
      expect(view).toMatchObject({
        status: 'new',
        technician: null,
        confirmationStatus: 'rejected',
        cycle: 3,
        rejectionCount: 2,
      });
      expect(await kinds(manager(), t.id)).toContain('ticket.escalated');
      expect(
        code(
          await call(w, 'GET', `/technician/tickets/${t.id}`, {
            token: w.a.tokens.technician,
          }),
        ),
      ).toEqual({ status: 404, code: 'TICKET_NOT_FOUND' });
      const trail = await call(
        w,
        'GET',
        `/maintenance/tickets/${t.id}/assignments`,
        { token: manager() },
      ).expect(200);
      expect((trail.body as { data: object[] }).data.at(-1)).toMatchObject({
        type: 'released',
        from: { id: w.a.ids.technician },
        by: null,
        reasonCode: 'escalated',
        cycle: 3,
      });
      expect(
        ((await dispatchView(t.id)).feedback as object[]).map((f) => f),
      ).toMatchObject([
        { cycle: 1, kind: 'rejected', reasonCode: 'not_fixed', rating: null },
        { cycle: 2, kind: 'rejected', reasonCode: 'poor_quality' },
      ]);
    });

    it('nobody confirms: the sweep closes it after autoCloseHours, and the reporter is told', async () => {
      const t = await completed();
      expect(await sweep()).toBeGreaterThanOrEqual(0);
      expect(await dispatchView(t.id)).toMatchObject({ status: 'completed' });
      await sweep(new Date(Date.now() + 73 * 3_600_000));
      expect(await dispatchView(t.id)).toMatchObject({
        status: 'closed',
        confirmationStatus: 'auto_closed',
      });
      expect(await kinds(w.a.tokens.owner, t.id)).toContain(
        'ticket.auto_closed',
      );
      const history = await call(
        w,
        'GET',
        `/maintenance/tickets/${t.id}/history`,
        { token: manager() },
      ).expect(200);
      expect((history.body as { data: object[] }).data.at(-1)).toMatchObject({
        fromStatus: 'completed',
        toStatus: 'closed',
        actor: null,
      });
      // Too late to confirm; a reopen is the way back.
      const late = await as(w.a.tokens.owner, t.id, 'confirm', { rating: 3 });
      expect(code(late)).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
      });
    });

    it('reopen within the window, as a rejection; never after it', async () => {
      const t = await completed();
      await as(w.a.tokens.owner, t.id, 'confirm', { rating: 5 }).expect(204);
      await as(w.a.tokens.owner, t.id, 'reopen', {
        reasonCode: 'problem_returned',
        reason: 'Leaking again',
      }).expect(204);
      expect(await dispatchView(t.id)).toMatchObject({
        status: 'assigned',
        technician: { id: w.a.ids.technician },
        confirmationStatus: 'rejected',
        cycle: 2,
        rejectionCount: 1,
        closedAt: null,
      });
      expect(await kinds(manager(), t.id)).toContain('ticket.reopened');

      const old = await completed();
      await as(w.a.tokens.owner, old.id, 'confirm', { rating: 5 }).expect(204);
      await setTicket(old.id, {
        closedAt: new Date(Date.now() - 8 * 24 * 3_600_000),
      });
      const late = await as(w.a.tokens.owner, old.id, 'reopen', {
        reasonCode: 'problem_returned',
        reason: 'Back',
      });
      expect(code(late)).toEqual({
        status: 409,
        code: 'TICKET_REOPEN_WINDOW_PASSED',
      });
      expect(await dispatchView(old.id)).toMatchObject({ status: 'closed' });
    });

    it('cancel: the reporter until the work starts, a dispatcher until it is closed', async () => {
      const early = (
        await open(w.a.tokens.owner, { unitId: w.a.homeUnitId }).expect(201)
      ).body as { id: string };
      expect(code(await as(w.a.tokens.owner, early.id, 'cancel', {}))).toEqual({
        status: 400,
        code: 'REASON_REQUIRED',
      });
      await as(w.a.tokens.owner, early.id, 'cancel', {
        reasonCode: 'resolved_without_visit',
      }).expect(204);
      expect(await dispatchView(early.id)).toMatchObject({
        status: 'cancelled',
        cancelledAt: expect.any(String) as string,
      });

      const started = await assigned(w.a.ids.technician);
      await work(started.id).start();
      const tooLate = await as(w.a.tokens.owner, started.id, 'cancel', {
        reasonCode: 'reporter_request',
      });
      expect(code(tooLate)).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
      });
      // The primary sees it but neither reported nor created it.
      const byFamily = (
        await open(w.a.tokens.family, { unitId: w.a.homeUnitId }).expect(201)
      ).body as { id: string };
      expect(
        code(
          await as(w.a.tokens.owner, byFamily.id, 'cancel', {
            reasonCode: 'duplicate',
          }),
        ),
      ).toEqual({ status: 403, code: 'TICKET_ACTION_NOT_ALLOWED' });

      // A dispatcher cancels a completed ticket: nothing waits any more.
      await work(started.id).complete();
      await call(w, 'POST', `/maintenance/tickets/${started.id}/cancel`, {
        token: manager(),
        body: { reasonCode: 'invalid' },
      }).expect(204);
      expect(await dispatchView(started.id)).toMatchObject({
        status: 'cancelled',
        confirmationStatus: null,
      });
      expect(await kinds(w.a.tokens.technician, started.id)).toContain(
        'ticket.status_changed',
      );
      // Closed is final, for dispatch too.
      const closed = await completed();
      await as(w.a.tokens.owner, closed.id, 'confirm', { rating: 5 }).expect(
        204,
      );
      const after = await call(
        w,
        'POST',
        `/maintenance/tickets/${closed.id}/cancel`,
        { token: manager(), body: { reasonCode: 'invalid' } },
      );
      expect(code(after)).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
      });
    });
  });

  describe('messages', () => {
    const MESSAGE = [
      'body',
      'createdAt',
      'deleted',
      'id',
      'sender',
      'sender.firstName',
      'sender.id',
      'senderKind',
    ];
    const post = (path: string, token: string, body: object) =>
      call(w, 'POST', path, { token, body });
    const bodies = async (path: string, token: string) =>
      (
        (await call(w, 'GET', path, { token }).expect(200)).body as {
          data: { body: string }[];
        }
      ).data.map((m) => m.body);

    it('the people on a ticket talk; internal messages stay with staff; nobody is told the words', async () => {
      // A family member's ticket on the owner's home, assigned.
      const t = (
        await open(w.a.tokens.family, { unitId: w.a.homeUnitId }).expect(201)
      ).body as { id: string };
      await call(w, 'POST', `/maintenance/tickets/${t.id}/assign`, {
        token: manager(),
        body: { technicianId: w.a.ids.technician },
      }).expect(204);
      const resident = `/tickets/${t.id}/messages`;
      const tech = `/technician/tickets/${t.id}/messages`;
      const dispatch = `/maintenance/tickets/${t.id}/messages`;

      const created = await post(resident, w.a.tokens.family, {
        body: 'The valve is behind the washing machine',
      }).expect(201);
      expect(keyPaths(created.body)).toEqual(['createdAt', 'id']);
      // The primary sees the ticket, so they take part.
      await post(resident, w.a.tokens.owner, { body: 'Ring twice' }).expect(
        201,
      );
      await post(tech, w.a.tokens.technician, {
        body: 'Coming at five',
      }).expect(201);
      await post(tech, w.a.tokens.technician, {
        body: 'Needs a new part from the store',
        internal: true,
      }).expect(201);
      await post(dispatch, manager(), {
        body: 'Part ordered',
        internal: true,
      }).expect(201);
      // A resident cannot write for staff only.
      const sneaky = await post(resident, w.a.tokens.family, {
        body: 'x',
        internal: true,
      });
      expect(err(sneaky).fields).toEqual([
        { field: 'internal', code: 'FIELD_NOT_ALLOWED' },
      ]);

      const asResident = await call(w, 'GET', resident, {
        token: w.a.tokens.owner,
      }).expect(200);
      expect(keyPaths(asResident.body)).toEqual(listKeys(MESSAGE));
      expect(await bodies(resident, w.a.tokens.owner)).toEqual([
        'The valve is behind the washing machine',
        'Ring twice',
        'Coming at five',
      ]);
      const asTech = await call(w, 'GET', tech, {
        token: w.a.tokens.technician,
      }).expect(200);
      // First names only, no account id (ADR 0032).
      expect(keyPaths(asTech.body)).toEqual(
        listKeys(
          [
            ...MESSAGE.filter((k) => k !== 'sender.id'),
            'internal',
            'mine',
          ].sort(),
        ),
      );
      expect(await bodies(tech, w.a.tokens.technician)).toHaveLength(5);
      const asDispatch = await call(w, 'GET', dispatch, {
        token: manager(),
      }).expect(200);
      expect(keyPaths(asDispatch.body)).toEqual(
        listKeys(
          [
            'body',
            'createdAt',
            'deleted',
            'id',
            'internal',
            'sender',
            'sender.fullName',
            'sender.id',
            'senderKind',
          ].sort(),
        ),
      );
      expect(
        (asResident.body as { data: { senderKind: string }[] }).data.map(
          (m) => m.senderKind,
        ),
      ).toEqual(['resident', 'resident', 'staff']);

      // Everyone who can read a message is told — never with its words.
      expect(await kinds(w.a.tokens.technician, t.id)).toContain(
        'ticket.message',
      );
      expect(await kinds(w.a.tokens.owner, t.id)).toContain('ticket.message');
      const inbox = JSON.stringify(
        (
          await call(w, 'GET', '/me/notifications', {
            token: w.a.tokens.owner,
          }).expect(200)
        ).body,
      );
      for (const words of ['valve', 'Coming at five', 'Needs a new part'])
        expect(inbox).not.toContain(words);
      // An internal message tells staff only: the family member, who sent
      // nothing internal, heard of three messages it may read.
      const familyTold = (await kinds(w.a.tokens.family, t.id)).filter(
        (k) => k === 'ticket.message',
      );
      expect(familyTold).toHaveLength(2);

      // Others: not found.
      for (const token of [w.a.tokens.tenant, w.a.tokens.landlord]) {
        const res = await call(w, 'GET', resident, { token });
        expect(code(res)).toEqual({ status: 404, code: 'TICKET_NOT_FOUND' });
      }
    });

    it('no message on a closed or cancelled ticket', async () => {
      const t = (
        await open(w.a.tokens.owner, { unitId: w.a.homeUnitId }).expect(201)
      ).body as { id: string };
      await call(w, 'POST', `/tickets/${t.id}/cancel`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'duplicate' },
      }).expect(204);
      const res = await post(`/tickets/${t.id}/messages`, w.a.tokens.owner, {
        body: 'Never mind',
      });
      expect(code(res)).toEqual({
        status: 409,
        code: 'TICKET_INVALID_TRANSITION',
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
