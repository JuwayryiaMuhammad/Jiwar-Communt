import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';
import {
  cacheKey,
  PermissionsService,
} from '../../src/core/access/permissions.service';
import { RolesService } from '../../src/core/access/roles.service';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { PrismaService } from '../../src/core/database/prisma.service';
import { REDIS } from '../../src/core/redis/redis.module';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/** RolesService (ADR 0010): edits apply on the next request, per compound. */
describe('Roles', () => {
  let h: HttpHarness;
  let roles: RolesService;
  let permissions: PermissionsService;
  let cls: ClsService<AppClsStore>;
  let redis: Redis;
  let prisma: PrismaService;

  beforeAll(async () => {
    h = await createHttpHarness();
    roles = h.moduleRef.get(RolesService);
    permissions = h.moduleRef.get(PermissionsService);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    redis = h.moduleRef.get<Redis>(REDIS);
    prisma = h.moduleRef.get(PrismaService);
  });

  afterAll(() => h.close());

  /** Runs `fn` as an account of the tenant, like a guarded request would. */
  function as<T>(tenantId: string, accountId: string, fn: () => Promise<T>) {
    return cls.run(async () => {
      cls.set('tenantId', tenantId);
      cls.set('accountId', accountId);
      return await fn();
    });
  }

  async function compound() {
    const tenant = await h.createTenant('Compound R');
    const manager = await h.createAccount(tenant.id, {
      type: 'manager',
      email: uniqueEmail('mgr'),
      phone: uniquePhone(),
    });
    const token = await h.tokenFor({
      sub: manager.id,
      tid: tenant.id,
      typ: 'manager',
    });
    const list = await as(tenant.id, manager.id, () => roles.list());
    const role = (key: string) => list.find((r) => r.key === key)!;
    return {
      tenant,
      manager,
      token,
      managerRole: role('manager'),
      residentRole: role('resident'),
    };
  }

  const createUnit = (token: string, code: string) =>
    h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code });

  it('system roles are identified by key, with no stored display name', async () => {
    const c = await compound();
    expect(c.managerRole).toMatchObject({
      key: 'manager',
      kind: 'manager',
      isSystem: true,
      name: null,
    });
    expect(c.residentRole).toMatchObject({
      key: 'resident',
      kind: 'resident',
      isSystem: true,
      name: null,
      permissions: [
        'household.delegate',
        'household.manage',
        'profile.photo',
        'units.read',
        'visitors.invite',
        'workers.manage',
      ],
    });
  });

  it('removing a permission applies on the next request, even with a stale cache entry', async () => {
    const c = await compound();
    await createUnit(c.token, 'U-1').expect(201); // warms the cache for the current version
    const oldPermissions = (
      await as(c.tenant.id, c.manager.id, () =>
        h.moduleRef.get(RolesService).get(c.managerRole.id),
      )
    ).permissions;

    await as(c.tenant.id, c.manager.id, () =>
      roles.replacePermissions(
        c.managerRole.id,
        c.managerRole.permissions.filter((p) => p !== 'units.create'),
      ),
    );

    // Simulate the race: a request that read the old permissions writes them
    // to the cache after the edit — under the old version, never read again.
    await redis.set(
      cacheKey(c.tenant.id, c.managerRole.id, 1),
      JSON.stringify(oldPermissions),
    );

    const res = await createUnit(c.token, 'U-2').expect(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('editing roles in one compound does not affect another', async () => {
    const a = await compound();
    const b = await compound();
    await as(a.tenant.id, a.manager.id, () =>
      roles.replacePermissions(
        a.managerRole.id,
        a.managerRole.permissions.filter((p) => p !== 'units.create'),
      ),
    );
    await createUnit(a.token, 'X-1').expect(403);
    await createUnit(b.token, 'X-1').expect(201);
  });

  it("a compound cannot see or edit another compound's roles", async () => {
    const a = await compound();
    const b = await compound();
    await expect(
      as(b.tenant.id, b.manager.id, () => roles.get(a.managerRole.id)),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_FOUND' });
    await expect(
      as(b.tenant.id, b.manager.id, () =>
        roles.replacePermissions(a.residentRole.id, []),
      ),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_FOUND' });
  });

  it('rejects unknown permissions', async () => {
    const c = await compound();
    await expect(
      as(c.tenant.id, c.manager.id, () =>
        roles.replacePermissions(c.residentRole.id, [
          'units.read',
          'units.teleport',
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_PERMISSION',
      response: expect.objectContaining({
        params: { permissions: ['units.teleport'] },
      }) as unknown,
    });
  });

  it('rejects permissions not assignable to the role kind', async () => {
    const c = await compound();
    await expect(
      as(c.tenant.id, c.manager.id, () =>
        roles.replacePermissions(c.residentRole.id, [
          'units.read',
          'roles.manage',
        ]),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_NOT_ASSIGNABLE' });
  });

  it('protects the manager role from lockout', async () => {
    const c = await compound();
    for (const dropped of ['roles.manage', 'residents.manage']) {
      await expect(
        as(c.tenant.id, c.manager.id, () =>
          roles.replacePermissions(
            c.managerRole.id,
            c.managerRole.permissions.filter((p) => p !== dropped),
          ),
        ),
      ).rejects.toMatchObject({ code: 'ROLE_LOCKOUT' });
    }
    const after = await as(c.tenant.id, c.manager.id, () =>
      roles.get(c.managerRole.id),
    );
    expect(after.permissions).toEqual(c.managerRole.permissions);
  });

  it('a no-op edit does not bump the version', async () => {
    const c = await compound();
    const version = () =>
      as(
        c.tenant.id,
        c.manager.id,
        async () =>
          (
            await prisma.tenant.role.findUniqueOrThrow({
              where: { id: c.residentRole.id },
            })
          ).permissionsVersion,
      );
    const before = await version();
    await as(c.tenant.id, c.manager.id, () =>
      // The same set in another order: nothing changes.
      roles.replacePermissions(c.residentRole.id, [
        'units.read',
        'household.manage',
        'household.delegate',
        'workers.manage',
        'visitors.invite',
        'profile.photo',
      ]),
    );
    expect(await version()).toBe(before);
    await as(c.tenant.id, c.manager.id, () =>
      roles.replacePermissions(c.residentRole.id, []),
    );
    expect(await version()).toBe(before + 1);
    expect([
      ...(await as(c.tenant.id, c.manager.id, () =>
        permissions.forRole(c.tenant.id, c.residentRole.id, before + 1),
      )),
    ]).toEqual([]);
  });
});
