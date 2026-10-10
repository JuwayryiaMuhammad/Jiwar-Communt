import { NONE } from '../../src/community/capabilities/capabilities';
import { DelegationsService } from '../../src/community/households/delegations.service';
import { DEFAULT_ROLES } from '../../src/core/access/default-roles';
import { RolesService } from '../../src/core/access/roles.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, sessionOf, type World } from './world';

const ME = [
  'email',
  'fullName',
  'id',
  'idDocumentNumberMasked',
  'idDocumentType',
  'nationality',
  'permissions',
  'phone',
  'photoUrl',
  'preferredLocale',
  'role',
  'role.id',
  'role.key',
  'role.name',
  'status',
  'type',
];
const MY_UNIT = [
  'building',
  'capacity',
  'code',
  'floor',
  'isPrimary',
  'resides',
  'unitId',
];

describe('API v0 — me', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  it('my account, with the document masked and no birth date', async () => {
    const res = await call(w, 'GET', '/me', { token: w.a.tokens.owner }).expect(
      200,
    );
    expect(keyPaths(res.body)).toEqual(ME);
    expect(res.body).toMatchObject({
      id: w.a.ids.owner,
      idDocumentNumberMasked: expect.stringMatching(/^••••\d{4}$/) as string,
    });

    const locale = await call(w, 'PATCH', '/me/locale', {
      token: w.a.tokens.owner,
      body: { locale: 'en' },
    }).expect(200);
    expect(locale.body).toEqual({ preferredLocale: 'en' });
  });

  it('my role and what it allows: the catalog’s defaults, sorted, and a change shows on the next request', async () => {
    const mine = async (token: string) =>
      (await call(w, 'GET', '/me', { token }).expect(200)).body as {
        role: { id: string; key: string; name: string | null };
        permissions: string[];
      };
    const defaults = (key: string) =>
      [...DEFAULT_ROLES.find((r) => r.key === key)!.permissions].sort();

    for (const [persona, key] of [
      ['owner', 'resident'],
      ['family', 'family_member'],
      ['manager', 'manager'],
      ['guard', 'guard'],
      ['technician', 'technician'],
    ] as const) {
      const me = await mine(w.a.tokens[persona]);
      expect(me.role).toMatchObject({ key, name: null });
      expect(me.permissions).toEqual(defaults(key));
    }

    // The role is this compound's own row, not the other compound's.
    const here = await mine(w.a.tokens.manager);
    const there = await mine(w.b.tokens.manager);
    expect(here.role.id).not.toBe(there.role.id);

    // The guard reads permissions through a cache keyed by the role's
    // version: `/me` must not serve the set from before the change.
    const roles = h.moduleRef.get(RolesService);
    const kept = here.permissions.filter((p) => p !== 'parcels.manage');
    await w.helpers.asManager(w.a, () =>
      roles.replacePermissions(here.role.id, kept),
    );
    try {
      expect((await mine(w.a.tokens.manager)).permissions).toEqual(kept);
      await call(w, 'GET', '/parcels', { token: w.a.tokens.manager }).expect(
        403,
      );
      // The other compound's manager role is untouched.
      expect((await mine(w.b.tokens.manager)).permissions).toEqual(
        defaults('manager'),
      );
    } finally {
      await w.helpers.asManager(w.a, () =>
        roles.replacePermissions(here.role.id, here.permissions),
      );
    }
    expect((await mine(w.a.tokens.manager)).permissions).toEqual(
      defaults('manager'),
    );
  });

  it('my units: the primary gets the household summary, a member its membership', async () => {
    const owner = await call(w, 'GET', '/me/units', {
      token: w.a.tokens.owner,
    }).expect(200);
    expect(keyPaths(owner.body)).toEqual(
      listKeys([
        ...MY_UNIT,
        'household',
        'household.memberCount',
        'household.pendingInvites',
      ]),
    );
    expect(owner.body).toMatchObject({
      data: [{ unitId: w.a.homeUnitId, capacity: 'owner', isPrimary: true }],
      nextCursor: null,
    });

    const family = await call(w, 'GET', '/me/units', {
      token: w.a.tokens.family,
    }).expect(200);
    expect(keyPaths(family.body)).toEqual(listKeys(MY_UNIT));
    expect(family.body).toMatchObject({
      data: [{ unitId: w.a.homeUnitId, capacity: 'member', isPrimary: false }],
    });

    const landlord = await call(w, 'GET', '/me/units', {
      token: w.a.tokens.landlord,
    }).expect(200);
    expect(landlord.body).toMatchObject({
      data: [{ unitId: w.a.rentedUnitId, capacity: 'owner', resides: false }],
    });
  });

  it('capabilities: every flag, and 404 on a unit I have no place in', async () => {
    const res = await call(
      w,
      'GET',
      `/me/units/${w.a.homeUnitId}/capabilities`,
      {
        token: w.a.tokens.owner,
      },
    ).expect(200);
    expect(keyPaths(res.body)).toEqual(Object.keys(NONE).sort());
    expect(res.body).toMatchObject({ householdManage: true, unitView: true });

    const stranger = await call(
      w,
      'GET',
      `/me/units/${w.a.homeUnitId}/capabilities`,
      {
        token: w.a.tokens.tenant,
      },
    );
    expect({ status: stranger.status, code: err(stranger).code }).toEqual({
      status: 404,
      code: 'UNIT_NOT_FOUND',
    });
  });

  it('my member permissions', async () => {
    const res = await call(
      w,
      'GET',
      `/me/units/${w.a.homeUnitId}/permissions`,
      {
        token: w.a.tokens.family,
      },
    ).expect(200);
    expect(keyPaths(res.body)).toEqual([
      'baseline',
      'grants',
      'grants[].capPerOperation',
      'grants[].grantedAt',
      'grants[].permission',
      'managedByPrimary',
      'memberId',
    ]);
  });

  it("my delegations, by the other side's name only", async () => {
    const inMonths = new Date(Date.now() + 90 * 86_400_000);
    await w.helpers.as(w.a, { id: w.a.ids.owner, type: 'resident' }, () =>
      h.moduleRef
        .get(DelegationsService)
        .create(w.a.homeUnitId, w.a.ids.family, ['workers'], inMonths),
    );
    const res = await call(w, 'GET', '/me/delegations', {
      token: w.a.tokens.family,
    }).expect(200);
    expect(keyPaths(res.body)).toEqual(
      listKeys([
        'counterpart',
        'counterpart.fullName',
        'counterpart.id',
        'expiresAt',
        'id',
        'role',
        'scopes',
        'unitCode',
        'unitId',
      ]),
    );
    expect(res.body).toMatchObject({
      data: [{ role: 'delegate', counterpart: { id: w.a.ids.owner } }],
    });
  });

  it('my sessions: list, revoke one, revoke all', async () => {
    const who = await w.helpers.resident(w.a, [w.a.homeUnitId], 'owner');
    const first = await w.tokenFor(w.a, who.id, 'resident');
    const second = await w.tokenFor(w.a, who.id, 'resident');

    const list = await call(w, 'GET', '/me/sessions', { token: first }).expect(
      200,
    );
    expect(keyPaths(list.body)).toEqual(
      listKeys(['createdAt', 'id', 'isCurrent', 'lastUsedAt', 'userAgent']),
    );
    const sessions = (
      list.body as { data: { id: string; isCurrent: boolean }[] }
    ).data;
    expect(sessions.find((s) => s.isCurrent)?.id).toBe(sessionOf(first));

    await call(w, 'POST', `/me/sessions/${sessionOf(second)}/revoke`, {
      token: first,
    }).expect(204);
    await call(w, 'GET', '/me', { token: second }).expect(401);

    const all = await call(w, 'POST', '/me/sessions/revoke-all', {
      token: first,
    }).expect(200);
    expect(all.body).toEqual({ revoked: 1 });
    await call(w, 'GET', '/me', { token: first }).expect(401);
  });

  it('my deletion request: none, requested, cancelled', async () => {
    const who = await w.helpers.resident(w.a, [w.a.homeUnitId], 'owner');
    const token = await w.tokenFor(w.a, who.id, 'resident');

    const none = await call(w, 'GET', '/me/deletion-request', { token });
    expect({ status: none.status, code: err(none).code }).toEqual({
      status: 404,
      code: 'DELETION_REQUEST_NOT_FOUND',
    });
    const wrong = await call(w, 'POST', '/me/deletion-request', {
      token,
      body: { confirmation: 'yes' },
    });
    expect(err(wrong).code).toBe('CONFIRMATION_MISMATCH');

    const made = await call(w, 'POST', '/me/deletion-request', {
      token,
      body: { confirmation: 'DELETE' },
    }).expect(201);
    const DELETION = [
      'assisted',
      'blockers',
      'effectiveAt',
      'id',
      'requestedAt',
      'status',
    ];
    expect(keyPaths(made.body)).toEqual(DELETION);
    const got = await call(w, 'GET', '/me/deletion-request', { token }).expect(
      200,
    );
    expect(keyPaths(got.body)).toEqual(DELETION);

    await call(w, 'POST', '/me/deletion-request/cancel', { token }).expect(204);
  });
});
