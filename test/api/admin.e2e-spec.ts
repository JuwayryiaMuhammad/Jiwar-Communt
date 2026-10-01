import { DEFAULT_ROLES } from '../../src/core/access/default-roles';
import { PERMISSIONS } from '../../src/core/access/permissions';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { AUDIT_OPAQUE, keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const ROLE = ['id', 'isSystem', 'key', 'kind', 'name', 'permissions'];
const SETTINGS = [
  'emergencyPhone',
  'familyJoinRequiresApproval',
  'gateRequestTimeoutSeconds',
  'maxActiveVisitorPasses',
  'maxHouseholdMembers',
  'timezone',
  'visitorDirections',
];

describe('API v0 — admin', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;

  it('roles and the permission catalog; a change applies on the next request', async () => {
    const roles = await call(w, 'GET', '/roles', { token: manager() }).expect(
      200,
    );
    expect(keyPaths(roles.body)).toEqual(listKeys(ROLE));
    const resident = (
      roles.body as { data: { id: string; key: string }[] }
    ).data.find((r) => r.key === 'resident')!;

    const one = await call(w, 'GET', `/roles/${resident.id}`, {
      token: manager(),
    }).expect(200);
    expect(keyPaths(one.body)).toEqual(ROLE);

    const catalog = await call(w, 'GET', '/permissions', {
      token: manager(),
    }).expect(200);
    expect(keyPaths(catalog.body)).toEqual(listKeys(['key', 'kinds']));
    expect((catalog.body as { data: unknown[] }).data).toHaveLength(
      Object.keys(PERMISSIONS).length,
    );

    const defaults = DEFAULT_ROLES.find(
      (r) => r.key === 'resident',
    )!.permissions;
    const without = defaults.filter((p) => p !== 'units.read');
    const replaced = await call(w, 'PUT', `/roles/${resident.id}/permissions`, {
      token: manager(),
      body: { permissions: without },
    }).expect(200);
    expect(keyPaths(replaced.body)).toEqual(ROLE);
    await call(w, 'GET', '/units', { token: w.a.tokens.owner }).expect(403);
    await call(w, 'PUT', `/roles/${resident.id}/permissions`, {
      token: manager(),
      body: { permissions: [...defaults] },
    }).expect(200);
    await call(w, 'GET', '/units', { token: w.a.tokens.owner }).expect(200);

    const unknown = await call(w, 'PUT', `/roles/${resident.id}/permissions`, {
      token: manager(),
      body: { permissions: ['everything'] },
    });
    expect(err(unknown).code).toBe('UNKNOWN_PERMISSION');
  });

  it('settings, with the time zone', async () => {
    const got = await call(w, 'GET', '/settings', { token: manager() }).expect(
      200,
    );
    expect(keyPaths(got.body)).toEqual(SETTINGS);
    const updated = await call(w, 'PATCH', '/settings', {
      token: manager(),
      body: { timezone: 'Asia/Riyadh', maxHouseholdMembers: 12 },
    }).expect(200);
    expect(updated.body).toMatchObject({
      timezone: 'Asia/Riyadh',
      maxHouseholdMembers: 12,
    });
    const bad = await call(w, 'PATCH', '/settings', {
      token: manager(),
      body: { timezone: 'Mars/Olympus' },
    });
    expect(err(bad).fields).toEqual([
      { field: 'timezone', code: 'INVALID_VALUE' },
    ]);
    // What visitors see (ADR 0030): over HTTP, null clears.
    const visitors = await call(w, 'PATCH', '/settings', {
      token: manager(),
      body: { visitorDirections: 'Gate 2', emergencyPhone: '+20 100 000 0456' },
    }).expect(200);
    expect(visitors.body).toMatchObject({
      visitorDirections: 'Gate 2',
      emergencyPhone: '+201000000456',
    });
    const wrong = await call(w, 'PATCH', '/settings', {
      token: manager(),
      body: { visitorDirections: 5, emergencyPhone: 'call me' },
    });
    expect(err(wrong).fields).toEqual([
      { field: 'visitorDirections', code: 'INVALID_TYPE' },
      { field: 'emergencyPhone', code: 'INVALID_PHONE' },
    ]);
    const cleared = await call(w, 'PATCH', '/settings', {
      token: manager(),
      body: { visitorDirections: null, emergencyPhone: null },
    }).expect(200);
    expect(cleared.body).toMatchObject({
      visitorDirections: null,
      emergencyPhone: null,
    });
  });

  it('the audit log, filtered, without IPs', async () => {
    const res = await call(w, 'GET', '/audit', {
      token: manager(),
      query: { action: 'tenant.settings_changed', limit: '1' },
    }).expect(200);
    expect(keyPaths(res.body, AUDIT_OPAQUE)).toEqual(
      listKeys([
        'action',
        'actorId',
        'actorType',
        'changes',
        'id',
        'metadata',
        'occurredAt',
        'requestId',
        'targetId',
        'targetType',
      ]),
    );
    // The platform's compound B entries never show up in A's log.
    const all = await call(w, 'GET', '/audit', {
      token: manager(),
      query: { targetId: w.b.ids.owner },
    }).expect(200);
    expect(all.body).toEqual({ data: [], nextCursor: null });
  });
});
