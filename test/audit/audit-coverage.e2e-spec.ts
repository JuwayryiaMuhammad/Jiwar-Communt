import { execSync } from 'node:child_process';
import { ClsService } from 'nestjs-cls';
import {
  CODE_ACCESS_CATALOG,
  type AccessCatalog,
} from '../../src/core/access/access-catalog';
import { RoleProvisioner } from '../../src/core/access/role-provisioner';
import { RolesService } from '../../src/core/access/roles.service';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PrismaService } from '../../src/core/database/prisma.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { hashPassword } from '../../src/core/platform/password';
import { PermissionSyncService } from '../../src/core/platform/permission-sync.service';
import { PlatformAuthService } from '../../src/core/platform/platform-auth.service';
import { PlatformBootstrapService } from '../../src/core/platform/platform-bootstrap.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantsService } from '../../src/core/platform/tenants.service';
import { ResidentsService } from '../../src/community/residents/residents.service';
import { auditReaders } from '../setup/audit';
import { COMMUNITY_COVERAGE } from '../setup/audit-coverage-split';
import { loginViaOtp } from '../setup/login';
import { waitForOtp } from '../setup/mailpit';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/**
 * One scenario per catalog entry (ADR 0014), each asserting actor, target
 * and changes. `covered` collects them; the catalog-completeness check at the
 * end fails when an action or event has no scenario here.
 */
const covered = new Set<string>();

describe('Audit coverage', () => {
  let h: HttpHarness;
  let read: ReturnType<typeof auditReaders>;
  let cls: ClsService<AppClsStore>;
  let tenants: TenantsService;
  let residents: ResidentsService;
  let roles: RolesService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    read = auditReaders(h);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    tenants = h.moduleRef.get(TenantsService);
    residents = h.moduleRef.get(ResidentsService);
    roles = h.moduleRef.get(RolesService);
  });

  afterAll(() => h.close());

  const manager = () => ({
    fullName: 'Audit Manager',
    nationalId: '29001010178888',
    phone: uniquePhone(),
    email: uniqueEmail('mgr'),
  });

  async function compound() {
    const created = await tenants.createTenant({
      name: 'Audit Court',
      manager: manager(),
    });
    const managerId = created.managers[0].id;
    const token = await h.tokenFor({
      sub: managerId,
      tid: created.id,
      typ: 'manager',
    });
    return { tenantId: created.id, managerId, token };
  }

  const asManager = <T>(
    c: { tenantId: string; managerId: string },
    fn: () => Promise<T>,
  ) =>
    cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      cls.set('accountId', c.managerId);
      cls.set('accountType', 'manager');
      return await fn();
    });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Exactly one entry for (action, target); marks the action covered. */
  async function single(tenantId: string, action: string, targetId: string) {
    const rows = await read.tenant(tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  // --------------------------------------------------------------------------
  describe('tenant actions', () => {
    it('account.created — by a manager over HTTP, with request origin', async () => {
      const c = await compound();
      const res = await h
        .http()
        .post(`${API}/accounts`)
        .set(bearer(c.token))
        .set('User-Agent', 'audit-test/1.0')
        .set('x-request-id', 'req-audit-1')
        .send({
          type: 'resident',
          fullName: 'Created Person',
          nationalId: '29001010112223',
          phone: uniquePhone(),
          email: uniqueEmail('created'),
        })
        .expect(201);
      const id = (res.body as { id: string }).id;

      const row = await single(c.tenantId, 'account.created', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'account',
        requestId: 'req-audit-1',
        userAgent: 'audit-test/1.0',
      });
      expect(row.ip).toMatch(/127\.0\.0\.1|::1/);
      expect(row.changes).toMatchObject({
        type: { from: null, to: 'resident' },
        status: { from: null, to: 'active' },
        fullName: { changed: true },
        nationalId: { changed: true },
        phone: { changed: true },
        email: { changed: true },
      });
    });

    it('account.status_changed', async () => {
      const c = await compound();
      const person = await h.createAccount(c.tenantId, {
        type: 'resident',
        email: uniqueEmail('st'),
        phone: uniquePhone(),
      });
      await h
        .http()
        .patch(`${API}/accounts/${person.id}/status`)
        .set(bearer(c.token))
        .send({ status: 'inactive' })
        .expect(200);
      const row = await single(c.tenantId, 'account.status_changed', person.id);
      expect(row).toMatchObject({ actorType: 'account', actorId: c.managerId });
      expect(row.changes).toEqual({
        status: { from: 'active', to: 'inactive' },
      });
      expect(row.metadata).toEqual({ sessionsRevoked: 0 });
    });

    it('account.contact_changed — values never recorded', async () => {
      const c = await compound();
      const unit = await h
        .http()
        .post(`${API}/units`)
        .set(bearer(c.token))
        .send({ code: 'C-1' });
      const resident = await asManager(c, () =>
        residents.createResident({
          fullName: 'Contact Person',
          nationalId: '29001010123334',
          phone: uniquePhone(),
          email: uniqueEmail('old'),
          units: [
            {
              unitId: (unit.body as { id: string }).id,
              occupancyType: 'owner',
            },
          ],
        }),
      );
      await asManager(c, () =>
        residents.updateContact(resident.id, {
          email: uniqueEmail('new'),
          phone: uniquePhone(),
        }),
      );
      const row = await single(
        c.tenantId,
        'account.contact_changed',
        resident.id,
      );
      expect(row).toMatchObject({ actorType: 'account', actorId: c.managerId });
      expect(row.changes).toEqual({
        email: { changed: true },
        phone: { changed: true },
      });
      expect(row.metadata).toEqual({ codesInvalidated: 0 });
    });

    it('unit.created', async () => {
      const c = await compound();
      const res = await h
        .http()
        .post(`${API}/units`)
        .set(bearer(c.token))
        .send({ code: 'U-7', building: 'B', floor: 2 })
        .expect(201);
      const row = await single(
        c.tenantId,
        'unit.created',
        (res.body as { id: string }).id,
      );
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'unit',
      });
      expect(row.changes).toEqual({
        code: { from: null, to: 'U-7' },
        building: { from: null, to: 'B' },
        floor: { from: null, to: 2 },
      });
    });

    it('occupancy.created and occupancy.ended', async () => {
      const c = await compound();
      const unit = await h
        .http()
        .post(`${API}/units`)
        .set(bearer(c.token))
        .send({ code: 'O-1' });
      const unitId = (unit.body as { id: string }).id;
      const resident = await asManager(c, () =>
        residents.createResident({
          fullName: 'Occupant',
          nationalId: '29001010134445',
          phone: uniquePhone(),
          email: uniqueEmail('occ'),
          units: [{ unitId, occupancyType: 'tenant' }],
        }),
      );
      const occupancyId = resident.occupancies[0].id;

      const created = await single(
        c.tenantId,
        'occupancy.created',
        occupancyId,
      );
      expect(created).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'occupancy',
      });
      expect(created.changes).toEqual({
        unitId: { from: null, to: unitId },
        accountId: { from: null, to: resident.id },
        occupancyType: { from: null, to: 'tenant' },
        status: { from: null, to: 'active' },
      });

      await asManager(c, () => residents.endOccupancy(occupancyId));
      const ended = await single(c.tenantId, 'occupancy.ended', occupancyId);
      expect(ended).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
      });
      expect(ended.changes).toMatchObject({
        status: { from: 'active', to: 'ended' },
        endedAt: { from: null, to: expect.any(String) as string },
      });
    });

    it('role.permissions_replaced', async () => {
      const c = await compound();
      const list = await asManager(c, () => roles.list());
      const resident = list.find((r) => r.key === 'resident')!;
      await asManager(c, () => roles.replacePermissions(resident.id, []));
      const row = await single(
        c.tenantId,
        'role.permissions_replaced',
        resident.id,
      );
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'role',
      });
      expect(row.changes).toEqual({
        permissions: { from: ['units.read'], to: [] },
      });
      expect(row.metadata).toMatchObject({
        roleKey: 'resident',
        permissionsVersion: 2,
      });
    });

    it('role.permissions_synced — audit.read reaches an existing compound, actor system', async () => {
      // A compound created before `audit.read` existed.
      const withoutAudit: AccessCatalog = (() => {
        const permissions = { ...CODE_ACCESS_CATALOG.permissions } as Record<
          string,
          (typeof CODE_ACCESS_CATALOG.permissions)[string]
        >;
        delete permissions['audit.read'];
        return {
          ...CODE_ACCESS_CATALOG,
          permissions,
          defaultRoles: CODE_ACCESS_CATALOG.defaultRoles.map((r) => ({
            ...r,
            permissions: r.permissions.filter((p) => p !== 'audit.read'),
          })),
        };
      })();
      const tenantId = newId();
      await h.moduleRef
        .get(GlobalDbService)
        .tenant.create({ data: { id: tenantId, name: 'Old Compound' } });
      await cls.run(async () => {
        cls.set('tenantId', tenantId);
        await h.moduleRef
          .get(TenantTx)
          .withTenantTx((tx) =>
            new RoleProvisioner(withoutAudit).provision(tx, tenantId),
          );
      });

      const report = await h.moduleRef
        .get(PermissionSyncService)
        .syncTenant(tenantId);
      expect(report.added).toEqual(['audit.read']);

      const managerRole = await cls.run(async () => {
        cls.set('tenantId', tenantId);
        return await h.moduleRef
          .get(PrismaService)
          .tenant.role.findUniqueOrThrow({
            where: { tenantId_key: { tenantId, key: 'manager' } },
            include: { permissions: true },
          });
      });
      expect(managerRole.permissions.map((p) => p.permission)).toContain(
        'audit.read',
      );

      const row = await single(
        tenantId,
        'role.permissions_synced',
        managerRole.id,
      );
      expect(row).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: 'role',
      });
      const change = row.changes as {
        permissions: { from: string[]; to: string[] };
      };
      expect(change.permissions.from).not.toContain('audit.read');
      expect(change.permissions.to).toContain('audit.read');
      expect(row.metadata).toMatchObject({
        roleKey: 'manager',
        added: ['audit.read'],
      });
      // The resident role did not change, so it has no entry.
      expect(
        await read.tenant(tenantId, { action: 'role.permissions_synced' }),
      ).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  describe('platform actions', () => {
    const adminId = newId();
    /** As a platform request would run: the guard puts the admin in context. */
    const asAdmin = <T>(fn: () => Promise<T>) =>
      cls.run(async () => {
        cls.set('platformAdminId', adminId);
        cls.set('ip', '203.0.113.7');
        return await fn();
      });

    async function platformSingle(action: string, targetId: string) {
      const rows = await read.platform({ action, targetId });
      expect(rows).toHaveLength(1);
      covered.add(action);
      return rows[0];
    }

    it('tenant.created — by the platform admin; the first manager in the compound log', async () => {
      const m = manager();
      const created = await asAdmin(() =>
        tenants.createTenant({ name: 'Admin Court', manager: m }),
      );
      const row = await platformSingle('tenant.created', created.id);
      expect(row).toMatchObject({
        actorType: 'platform_admin',
        actorId: adminId,
        targetType: 'tenant',
        targetTenantId: created.id,
        ip: '203.0.113.7',
      });
      expect(row.changes).toEqual({
        name: { from: null, to: 'Admin Court' },
        status: { from: null, to: 'active' },
      });
      const account = (
        await read.tenant(created.id, { action: 'account.created' })
      )[0];
      expect(account).toMatchObject({
        actorType: 'platform_admin',
        actorId: adminId,
        targetId: created.managers[0].id,
      });
    });

    it('tenant.created — as system when no admin is in context', async () => {
      const created = await tenants.createTenant({
        name: 'System Court',
        manager: manager(),
      });
      const row = (
        await read.platform({ action: 'tenant.created', targetId: created.id })
      )[0];
      expect(row).toMatchObject({ actorType: 'system', actorId: null });
    });

    it('tenant.status_changed — with the sessions it ended', async () => {
      const created = await tenants.createTenant({
        name: 'Status Court',
        manager: manager(),
      });
      await asAdmin(() => tenants.setStatus(created.id, 'suspended'));
      const row = await platformSingle('tenant.status_changed', created.id);
      expect(row).toMatchObject({
        actorType: 'platform_admin',
        actorId: adminId,
        targetTenantId: created.id,
      });
      expect(row.changes).toEqual({
        status: { from: 'active', to: 'suspended' },
      });
      expect(row.metadata).toEqual({ sessionsRevoked: 0 });
      // A no-op change is not audited.
      await asAdmin(() => tenants.setStatus(created.id, 'suspended'));
      expect(
        await read.platform({
          action: 'tenant.status_changed',
          targetId: created.id,
        }),
      ).toHaveLength(1);
    });

    it('tenant.manager_added — plus account.created in the compound log', async () => {
      const created = await tenants.createTenant({
        name: 'Managers Court',
        manager: manager(),
      });
      const added = await asAdmin(() =>
        tenants.addManager(created.id, manager()),
      );
      const row = await platformSingle('tenant.manager_added', added.id);
      expect(row).toMatchObject({
        actorType: 'platform_admin',
        actorId: adminId,
        targetType: 'account',
        targetTenantId: created.id,
      });
      const inCompound = await read.tenant(created.id, {
        action: 'account.created',
        targetId: added.id,
      });
      expect(inCompound).toHaveLength(1);
      expect(inCompound[0]).toMatchObject({
        actorType: 'platform_admin',
        actorId: adminId,
      });
    });

    it('platform_admin.created — by the bootstrap, as system', async () => {
      const globalDb = h.moduleRef.get(GlobalDbService);
      await globalDb.platformSession.deleteMany();
      await globalDb.platformAdmin.deleteMany();
      await h.moduleRef
        .get(PlatformBootstrapService)
        .run({ email: 'Boot@Jiwar.Test', password: 'bootstrap-password-1' });
      const admin = await globalDb.platformAdmin.findUniqueOrThrow({
        where: { email: 'boot@jiwar.test' },
      });
      const row = await platformSingle('platform_admin.created', admin.id);
      expect(row).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: 'platform_admin',
      });
      expect(row.changes).toEqual({
        email: { changed: true },
        status: { from: null, to: 'active' },
        mustChangePassword: { from: null, to: true },
      });
      expect(row.metadata).toEqual({ source: 'bootstrap' });
    });

    it('platform_admin.password_changed — by the admin, no hash recorded', async () => {
      const globalDb = h.moduleRef.get(GlobalDbService);
      const admin = await globalDb.platformAdmin.create({
        data: {
          id: newId(),
          email: uniqueEmail('admin'),
          passwordHash: await hashPassword('old-password-1234'),
          mustChangePassword: true,
        },
      });
      await cls.run(async () => {
        cls.set('platformAdminId', admin.id);
        await h.moduleRef
          .get(PlatformAuthService)
          .changePassword('old-password-1234', 'new-password-5678');
      });
      const row = await platformSingle(
        'platform_admin.password_changed',
        admin.id,
      );
      expect(row).toMatchObject({
        actorType: 'platform_admin',
        actorId: admin.id,
      });
      expect(row.changes).toEqual({
        passwordHash: { changed: true },
        mustChangePassword: { from: true, to: false },
      });
      expect(JSON.stringify(row)).not.toContain('$argon2');
    });
  });

  // --------------------------------------------------------------------------
  describe('system actor', () => {
    it('everything the seed writes is audited as system', async () => {
      execSync('pnpm seed', { env: process.env, stdio: 'pipe' });
      const globalDb = h.moduleRef.get(GlobalDbService);
      const seeded = await globalDb.tenant.findMany({
        where: { name: { in: ['Nile Gardens (demo)', 'Desert Rose (demo)'] } },
      });
      expect(seeded).toHaveLength(2);
      for (const t of seeded) {
        const rows = [
          ...(await read.tenant(t.id)),
          ...(await read.platform({ targetTenantId: t.id })),
        ];
        expect(rows.map((r) => r.action)).toEqual(
          expect.arrayContaining([
            'tenant.created',
            'account.created',
            'unit.created',
            'occupancy.created',
          ]),
        );
        for (const r of rows)
          expect(r).toMatchObject({ actorType: 'system', actorId: null });
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('security events', () => {
    const hasher = () => h.moduleRef.get(IdentifierHasher);
    const hashOf = (email: string) =>
      hasher().hashIdentifier({ type: 'email', value: email });

    async function event(
      name: string,
      where: Record<string, unknown>,
      timeoutMs = 5000,
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = await read.security({ event: name, ...where });
        if (rows.length || Date.now() > deadline) {
          expect(rows.length).toBeGreaterThan(0);
          covered.add(name);
          return rows;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    async function residentOf(c: { tenantId: string }) {
      const email = uniqueEmail('sec');
      const account = await h.createAccount(c.tenantId, {
        type: 'resident',
        email,
        phone: uniquePhone(),
      });
      return { email, id: account.id };
    }

    it('otp.requested — known and unknown identifiers alike', async () => {
      const c = await compound();
      const r = await residentOf(c);
      await h
        .http()
        .post(`${API}/auth/otp/request`)
        .set('Accept-Language', 'en')
        .send({ identifier: r.email });
      const known = await event('otp.requested', {
        identifierHash: hashOf(r.email),
      });
      expect(known[0].metadata).toEqual({ locale: 'en', destinations: 1 });
      expect(known[0].accountId).toBeNull();

      const nobody = uniqueEmail('nobody');
      await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: nobody });
      const unknown = await event('otp.requested', {
        identifierHash: hashOf(nobody),
      });
      expect(unknown[0].metadata).toEqual({ locale: 'ar', destinations: 0 });
    });

    it('otp.verify_failed and otp.challenge_exhausted', async () => {
      const c = await compound();
      const r = await residentOf(c);
      const since = new Date();
      await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier: r.email });
      const code = await waitForOtp(r.email, since);
      const wrong = code === '000000' ? '000001' : '000000';
      for (let i = 0; i < 5; i++) {
        await h
          .http()
          .post(`${API}/auth/otp/verify`)
          .send({ identifier: r.email, code: wrong })
          .expect(401);
      }
      const failed = await event('otp.verify_failed', {
        identifierHash: hashOf(r.email),
      });
      expect(failed).toHaveLength(5);
      const exhausted = await event('otp.challenge_exhausted', {
        identifierHash: hashOf(r.email),
      });
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0].metadata).toMatchObject({ attempts: 5 });
    });

    it('otp.rate_limited', async () => {
      const email = uniqueEmail('limited');
      for (let i = 0; i < 6; i++) {
        await h
          .http()
          .post(`${API}/auth/otp/request`)
          .send({ identifier: email });
      }
      const rows = await event('otp.rate_limited', {
        identifierHash: hashOf(email),
      });
      expect(rows[0].metadata).toEqual({
        flow: 'request',
        scope: 'identifier',
      });
    });

    it('login.succeeded, session.revoked (logout)', async () => {
      const c = await compound();
      const r = await residentOf(c);
      const tokens = await loginViaOtp(h, r.email, r.id);
      const ok = await event('login.succeeded', { accountId: r.id });
      expect(ok[0]).toMatchObject({ tenantId: c.tenantId });
      expect(ok[0].metadata).toEqual({ accountType: 'resident' });

      await h
        .http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);
      const revoked = await event('session.revoked', { accountId: r.id });
      expect(revoked[0].metadata).toMatchObject({ reason: 'logout' });
    });

    it('session.refresh_reuse_detected (+ session.revoked)', async () => {
      const c = await compound();
      const r = await residentOf(c);
      const tokens = await loginViaOtp(h, r.email, r.id);
      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);
      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
      const reuse = await event('session.refresh_reuse_detected', {
        accountId: r.id,
      });
      expect(reuse[0]).toMatchObject({ tenantId: c.tenantId });
      expect(reuse[0].metadata).toMatchObject({ how: 'old_secret' });
      const revoked = await read.security({
        event: 'session.revoked',
        accountId: r.id,
      });
      expect(
        revoked.map((e) => (e.metadata as { reason: string }).reason),
      ).toContain('refresh_reuse');
    });

    it('platform.login_failed, platform.login_locked, platform.login_succeeded', async () => {
      const globalDb = h.moduleRef.get(GlobalDbService);
      const email = uniqueEmail('padmin');
      const admin = await globalDb.platformAdmin.create({
        data: {
          id: newId(),
          email,
          passwordHash: await hashPassword('right-password-1'),
          mustChangePassword: false,
        },
      });
      const auth = h.moduleRef.get(PlatformAuthService);

      await auth.login(email, 'right-password-1', '10.9.0.1');
      const ok = await event('platform.login_succeeded', {
        platformAdminId: admin.id,
      });
      expect(ok[0].identifierHash).toBe(hashOf(email));

      const nobody = uniqueEmail('nobody');
      await expect(
        auth.login(nobody, 'whatever-password', '10.9.0.1'),
      ).rejects.toBeDefined();
      const unknown = await event('platform.login_failed', {
        identifierHash: hashOf(nobody),
      });
      expect(unknown[0]).toMatchObject({ platformAdminId: null });
      expect(unknown[0].metadata).toEqual({ reason: 'unknown_email' });

      for (let i = 0; i < 5; i++) {
        await expect(
          auth.login(email, 'wrong-password-0', '10.9.0.1'),
        ).rejects.toBeDefined();
      }
      const failed = await event('platform.login_failed', {
        platformAdminId: admin.id,
      });
      expect(
        failed.map((e) => (e.metadata as { reason: string }).reason),
      ).toContain('wrong_password');
      const locked = await event('platform.login_locked', {
        platformAdminId: admin.id,
      });
      expect(locked).toHaveLength(1);
    });

    it('no security event holds a raw email or phone', async () => {
      const rows = await read.security();
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(/@example\.test|@jiwar\.test/);
      expect(text).not.toMatch(/\+20\d{10}/);
    });

    it('fail-open: when events cannot be written, logins still work', async () => {
      const c = await compound();
      const r = await residentOf(c);
      const globalDb = h.moduleRef.get(GlobalDbService);
      const spy = jest
        .spyOn(globalDb, 'insertSecurityEvent')
        .mockRejectedValue(new Error('security_events unavailable'));
      try {
        const tokens = await loginViaOtp(h, r.email, r.id);
        await h
          .http()
          .get(`${API}/accounts/me`)
          .set('Authorization', `Bearer ${tokens.accessToken}`)
          .expect(200);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(
        await read.security({ accountId: r.id, event: 'login.succeeded' }),
      ).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  describe('catalog completeness', () => {
    it('every audit action and security event has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      // Phase 2 community entries have their own suite (audit-coverage-split).
      for (const key of COMMUNITY_COVERAGE) expect(all).toContain(key);
      const mine = all.filter((k) => !COMMUNITY_COVERAGE.includes(k)).sort();
      expect([...covered].sort()).toEqual(mine);
    });
  });
});
