import { execSync } from 'node:child_process';
import { ClsService } from 'nestjs-cls';
import {
  CODE_ACCESS_CATALOG,
  type AccessCatalog,
} from '../../src/access/access-catalog';
import { RoleProvisioner } from '../../src/access/role-provisioner';
import { RolesService } from '../../src/access/roles.service';
import type { AppClsStore } from '../../src/common/cls/app-cls';
import { newId } from '../../src/common/uuid';
import { GlobalDbService } from '../../src/database/global-db.service';
import { PrismaService } from '../../src/database/prisma.service';
import { TenantTx } from '../../src/database/tenant-tx.service';
import { hashPassword } from '../../src/platform/password';
import { PermissionSyncService } from '../../src/platform/permission-sync.service';
import { PlatformAuthService } from '../../src/platform/platform-auth.service';
import { PlatformBootstrapService } from '../../src/platform/platform-bootstrap.service';
import { PlatformModule } from '../../src/platform/platform.module';
import { TenantsService } from '../../src/platform/tenants.service';
import { ResidentsService } from '../../src/residents/residents.service';
import { auditReaders } from '../setup/audit';
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
    nationalId: '29001017778888',
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
          nationalId: '29001011112223',
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
          nationalId: '29001012223334',
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
          nationalId: '29001013334445',
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
});
