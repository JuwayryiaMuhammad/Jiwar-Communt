import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { AUDIT_OPAQUE, keyPaths, listKeys } from './keys';
import { call } from './request';
import { newManagerBody } from './routes/platform';
import { buildWorld, type World } from './world';

const TOKENS_FULL = [
  'accessToken',
  'accessTokenExpiresIn',
  'refreshToken',
  'refreshTokenExpiresAt',
  'scope',
];
const TENANT = ['createdAt', 'id', 'name', 'status'];
const MANAGER = ['email', 'fullName', 'id', 'phone', 'status'];
const TENANT_DETAIL = [
  ...TENANT,
  'managers',
  ...MANAGER.map((k) => `managers[].${k}`),
].sort();

describe('API v0 — platform', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  it('logs in, forces the password change, refreshes and logs out', async () => {
    const email = `admin-${uniqueSuffix()}@jiwar.test`;
    const password = 'first-password-123';
    await h.moduleRef.get(GlobalDbService).platformAdmin.create({
      data: {
        id: newId(),
        email,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      },
    });

    const login = await call(w, 'POST', '/platform/auth/login', {
      body: { email, password },
    }).expect(200);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(keyPaths(login.body)).toEqual([
      'accessToken',
      'accessTokenExpiresIn',
      'scope',
    ]);
    const restricted = (login.body as { accessToken: string }).accessToken;

    // The restricted token opens nothing else.
    const blocked = await call(w, 'GET', '/platform/tenants', {
      token: restricted,
    });
    expect(blocked.status).toBe(403);

    const changed = await call(w, 'POST', '/platform/auth/change-password', {
      token: restricted,
      body: { currentPassword: password, newPassword: 'second-password-456' },
    }).expect(200);
    expect(changed.headers['cache-control']).toBe('no-store');
    expect(keyPaths(changed.body)).toEqual(TOKENS_FULL);
    const full = changed.body as { refreshToken: string; accessToken: string };

    const refreshed = await call(w, 'POST', '/platform/auth/refresh', {
      body: { refreshToken: full.refreshToken },
    }).expect(200);
    expect(keyPaths(refreshed.body)).toEqual(TOKENS_FULL);
    const next = refreshed.body as { refreshToken: string };

    await call(w, 'POST', '/platform/auth/logout', {
      body: { refreshToken: next.refreshToken },
    }).expect(204);
    await call(w, 'POST', '/platform/auth/refresh', {
      body: { refreshToken: next.refreshToken },
    }).expect(401);
  });

  it('manages compounds and their managers', async () => {
    const token = w.platform.token;
    const created = await call(w, 'POST', '/platform/tenants', {
      token,
      body: { name: `Palm ${uniqueSuffix()}`, manager: newManagerBody() },
    }).expect(201);
    expect(keyPaths(created.body)).toEqual(TENANT_DETAIL);
    const id = (created.body as { id: string }).id;

    const got = await call(w, 'GET', `/platform/tenants/${id}`, {
      token,
    }).expect(200);
    expect(keyPaths(got.body)).toEqual(TENANT_DETAIL);

    const list = await call(w, 'GET', '/platform/tenants', {
      token,
      query: { limit: '1' },
    }).expect(200);
    expect(keyPaths(list.body)).toEqual(listKeys(TENANT));
    const first = list.body as { data: { id: string }[]; nextCursor: string };
    expect(first.data).toHaveLength(1);
    expect(first.data[0].id).toBe(id); // newest first
    const second = await call(w, 'GET', '/platform/tenants', {
      token,
      query: { limit: '1', cursor: first.nextCursor },
    }).expect(200);
    expect((second.body as { data: { id: string }[] }).data[0].id).not.toBe(id);

    const suspended = await call(w, 'PATCH', `/platform/tenants/${id}/status`, {
      token,
      body: { status: 'suspended' },
    }).expect(200);
    expect(keyPaths(suspended.body)).toEqual(TENANT);
    expect(suspended.body).toMatchObject({ status: 'suspended' });

    const manager = await call(w, 'POST', `/platform/tenants/${id}/managers`, {
      token,
      body: newManagerBody(),
    }).expect(201);
    expect(keyPaths(manager.body)).toEqual(MANAGER);
    const managerId = (manager.body as { id: string }).id;

    const deactivated = await call(
      w,
      'PATCH',
      `/platform/tenants/${id}/managers/${managerId}/status`,
      { token, body: { status: 'inactive' } },
    ).expect(200);
    expect(keyPaths(deactivated.body)).toEqual(MANAGER);
    expect(deactivated.body).toMatchObject({ status: 'inactive' });

    const audit = await call(w, 'GET', '/platform/audit', {
      token,
      query: { targetTenantId: id },
    }).expect(200);
    expect(keyPaths(audit.body, AUDIT_OPAQUE)).toEqual(
      listKeys([
        'action',
        'actorId',
        'actorType',
        'changes',
        'id',
        'ip',
        'metadata',
        'occurredAt',
        'requestId',
        'targetId',
        'targetTenantId',
        'targetType',
        'userAgent',
      ]),
    );
    expect(
      (audit.body as { data: { action: string }[] }).data.map((e) => e.action),
    ).toEqual(
      expect.arrayContaining([
        'tenant.created',
        'tenant.status_changed',
        'tenant.manager_added',
      ]),
    );

    const events = await call(w, 'GET', '/platform/security-events', {
      token,
      query: { tenantId: id, event: 'session.revoked' },
    }).expect(200);
    expect(keyPaths(events.body)).toEqual(listKeys([]));
  });

  it('lists security events with their fields', async () => {
    const res = await call(w, 'GET', '/platform/security-events', {
      token: w.platform.token,
      query: { event: 'platform.login_succeeded', limit: '1' },
    }).expect(200);
    const [event] = (res.body as { data: object[] }).data;
    expect(Object.keys(event).sort()).toEqual([
      'accountId',
      'event',
      'id',
      'identifierHash',
      'ip',
      'metadata',
      'occurredAt',
      'platformAdminId',
      'requestId',
      'tenantId',
      'userAgent',
    ]);
  });
});
