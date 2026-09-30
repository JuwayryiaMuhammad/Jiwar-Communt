import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { PrismaService } from '../../src/core/database/prisma.service';
import {
  TenantsService,
  type NewManager,
} from '../../src/core/platform/tenants.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { CODE_ACCESS_CATALOG } from '../../src/core/access/access-catalog';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp, requestAndVerify } from '../setup/login';
import { countEmails, waitForOtp } from '../setup/mailpit';

/** Compounds from the platform owner's side (ADR 0011). */
describe('TenantsService', () => {
  let h: HttpHarness;
  let tenants: TenantsService;
  let prisma: PrismaService;
  let cls: ClsService<AppClsStore>;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    tenants = h.moduleRef.get(TenantsService);
    prisma = h.moduleRef.get(PrismaService);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
  });

  afterAll(() => h.close());

  const newManager = (): NewManager => ({
    fullName: 'Compound Manager',
    idDocumentType: 'national_id' as const,
    idDocumentNumber: '29001010112222',
    phone: uniquePhone(),
    email: uniqueEmail('mgr'),
  });

  /** Reads tenant data as that tenant, like a guarded request would. */
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    cls.run(async () => {
      cls.set('tenantId', tenantId);
      return await fn();
    });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('creates a compound with its roles, catalog and first manager', async () => {
    const manager = newManager();
    const created = await tenants.createTenant({
      name: '  Palm Court  ',
      manager,
    });

    expect(created).toMatchObject({ name: 'Palm Court', status: 'active' });
    expect(created.managers).toEqual([
      {
        id: expect.any(String) as string,
        fullName: 'Compound Manager',
        email: manager.email,
        phone: manager.phone,
        status: 'active',
      },
    ]);

    const [roles, catalog] = await inTenant(created.id, () =>
      Promise.all([
        prisma.tenant.role.findMany({
          include: { permissions: true },
          orderBy: { key: 'asc' },
        }),
        prisma.tenant.tenantPermissionCatalog.findMany(),
      ]),
    );
    expect(roles.map((r) => [r.key, r.kind, r.isSystem, r.name])).toEqual([
      ['family_member', 'family', true, null],
      ['manager', 'manager', true, null],
      ['resident', 'resident', true, null],
    ]);
    for (const def of CODE_ACCESS_CATALOG.defaultRoles) {
      const role = roles.find((r) => r.key === def.key)!;
      expect(role.permissions.map((p) => p.permission).sort()).toEqual(
        [...def.permissions].sort(),
      );
    }
    expect(catalog.map((c) => c.permission).sort()).toEqual(
      Object.keys(CODE_ACCESS_CATALOG.permissions).sort(),
    );
  });

  it('the first manager logs in through the normal OTP flow and can work', async () => {
    const manager = newManager();
    const created = await tenants.createTenant({
      name: 'Login Court',
      manager,
    });
    const tokens = await loginViaOtp(h, manager.email, created.managers[0].id);
    await h
      .http()
      .post(`${API}/units`)
      .set(bearer(tokens.accessToken))
      .send({ code: 'L-1' })
      .expect(201);
    await h
      .http()
      .get(`${API}/accounts`)
      .set(bearer(tokens.accessToken))
      .expect(200);
  });

  it('shows the platform only compound fields and managers, never residents', async () => {
    const created = await tenants.createTenant({
      name: 'Private Court',
      manager: newManager(),
    });
    await h.createAccount(created.id, {
      type: 'resident',
      email: uniqueEmail('res'),
      phone: uniquePhone(),
    });

    const details = await tenants.get(created.id);
    expect(Object.keys(details).sort()).toEqual([
      'createdAt',
      'id',
      'managers',
      'name',
      'status',
    ]);
    expect(details.managers).toHaveLength(1);
    expect(Object.keys(details.managers[0]).sort()).toEqual([
      'email',
      'fullName',
      'id',
      'phone',
      'status',
    ]);
    expect((await tenants.list()).items.map((t) => t.id)).toContain(created.id);
  });

  it('lists compounds newest first, a page at a time, without gaps', async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      created.push(
        (
          await tenants.createTenant({
            name: `Paged ${i}`,
            manager: newManager(),
          })
        ).id,
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await tenants.list({ cursor, limit: 2 });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    // Newest first: the three appear in reverse creation order.
    expect(seen.filter((id) => created.includes(id))).toEqual(
      [...created].reverse(),
    );
  });

  it('rejects a bad name and an unknown compound', async () => {
    await expect(
      tenants.createTenant({ name: ' ', manager: newManager() }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      tenants.get('01920000-0000-7000-8000-0000000000ff'),
    ).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });

  it('adds managers and deactivates them (sessions end at once)', async () => {
    const created = await tenants.createTenant({
      name: 'Two Managers',
      manager: newManager(),
    });
    const second = newManager();
    const added = await tenants.addManager(created.id, second);
    const tokens = await loginViaOtp(h, second.email, added.id);
    await h
      .http()
      .get(`${API}/units`)
      .set(bearer(tokens.accessToken))
      .expect(200);

    await tenants.setManagerStatus(created.id, added.id, 'inactive');
    await h
      .http()
      .get(`${API}/units`)
      .set(bearer(tokens.accessToken))
      .expect(401);
    await h
      .http()
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
    expect(
      (await tenants.get(created.id)).managers.map((m) => m.status),
    ).toEqual(['active', 'inactive']);
  });

  it('manages manager accounts only', async () => {
    const created = await tenants.createTenant({
      name: 'Managers Only',
      manager: newManager(),
    });
    const resident = await h.createAccount(created.id, {
      type: 'resident',
      email: uniqueEmail('res'),
      phone: uniquePhone(),
    });
    await expect(
      tenants.setManagerStatus(created.id, resident.id, 'inactive'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    // And cannot reach a manager of another compound through this one.
    const other = await tenants.createTenant({
      name: 'Other',
      manager: newManager(),
    });
    await expect(
      tenants.setManagerStatus(created.id, other.managers[0].id, 'inactive'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  describe('suspension', () => {
    it('blocks OTP request, verify, account selection and refresh; revokes sessions', async () => {
      const manager = newManager();
      const created = await tenants.createTenant({
        name: 'Suspended Court',
        manager,
      });
      const managerId = created.managers[0].id;

      const live = await loginViaOtp(h, manager.email, managerId);
      const pendingTicket = await requestAndVerify(
        h,
        manager.email,
        manager.email,
      );
      const since = new Date();
      await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: manager.email })
        .expect(202);
      const pendingCode = await waitForOtp(manager.email, since);

      await tenants.setStatus(created.id, 'suspended');

      // A live session is revoked, and its access token stops working now.
      await h
        .http()
        .get(`${API}/units`)
        .set(bearer(live.accessToken))
        .expect(401);
      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: live.refreshToken })
        .expect(401);
      // A ticket or a code obtained before the suspension is useless.
      await h
        .http()
        .post(`${API}/auth/select-account`)
        .send({ loginTicket: pendingTicket.loginTicket, accountId: managerId })
        .expect(401);
      await h
        .http()
        .post(`${API}/auth/otp/verify`)
        .send({ identifier: manager.email, code: pendingCode })
        .expect(401);
      // New codes are not even sent, with the usual response.
      const after = new Date();
      const res = await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: manager.email })
        .expect(202);
      expect(res.body).toMatchObject({ code: 'OTP_REQUESTED' });
      expect(await countEmails(manager.email, after)).toBe(0);

      // Reactivation restores normal login.
      await tenants.setStatus(created.id, 'active');
      const again = await loginViaOtp(h, manager.email, managerId);
      await h
        .http()
        .get(`${API}/units`)
        .set(bearer(again.accessToken))
        .expect(200);
    });
  });
});
