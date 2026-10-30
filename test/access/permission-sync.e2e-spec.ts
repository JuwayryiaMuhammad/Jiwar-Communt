import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  CODE_ACCESS_CATALOG,
  catalogProblems,
  type AccessCatalog,
} from '../../src/core/access/access-catalog';
import { RoleLifecycle } from '../../src/core/access/role-lifecycle';
import { RoleProvisioner } from '../../src/core/access/role-provisioner';
import { newId } from '../../src/core/common/uuid';
import { PermissionSyncService } from '../../src/core/platform/permission-sync.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createTenant, tenantLifecycle } from '../setup/fixtures';

/**
 * `access:sync` against real compounds, with catalogs that simulate future
 * deploys: a new permission, a rename, a retirement, and a rollback.
 */
describe('Permission sync', () => {
  let h: DbHarness;

  beforeAll(async () => {
    h = await createDbHarness();
    Logger.overrideLogger(['error']);
  });

  afterAll(async () => {
    Logger.overrideLogger(['error', 'warn', 'log']);
    await h.close();
  });

  const base = CODE_ACCESS_CATALOG;

  /** The guard role as the code has it now (G4 added the parking reports). */
  const GUARD = ['gate.operate', 'parcels.handle', 'parking_reports.handle'];

  /** The code catalog plus a new manager-only permission. */
  const withExport: AccessCatalog = {
    ...base,
    permissions: {
      ...base.permissions,
      'units.export': { kinds: ['manager'] },
    },
    defaultRoles: base.defaultRoles.map((r) =>
      r.key === 'manager'
        ? { ...r, permissions: [...r.permissions, 'units.export'] }
        : r,
    ),
  };

  /** `units.create` renamed to `units.add`. */
  const renamed: AccessCatalog = (() => {
    const permissions: Record<
      string,
      { kinds: readonly ('manager' | 'resident' | 'staff')[] }
    > = {
      ...base.permissions,
      'units.add': { kinds: ['manager'] },
    };
    delete permissions['units.create'];
    return {
      ...base,
      permissions,
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.map((p) =>
          p === 'units.create' ? 'units.add' : p,
        ),
      })),
      renamed: { 'units.create': 'units.add' },
    };
  })();

  /** `accounts.read` retired. */
  const retired: AccessCatalog = (() => {
    const permissions = { ...base.permissions } as Record<
      string,
      { kinds: readonly ('manager' | 'resident' | 'staff')[] }
    >;
    delete permissions['accounts.read'];
    return {
      ...base,
      permissions,
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => p !== 'accounts.read'),
      })),
      retired: ['accounts.read'],
    };
  })();

  const sync = (
    catalog: AccessCatalog,
    tenantId: string,
    lifecycle = new RoleLifecycle(),
  ) =>
    new PermissionSyncService(
      catalog,
      h.globalDb,
      h.tenantTx,
      h.audit,
      lifecycle,
      h.cls,
    ).syncTenant(tenantId);

  async function role(tenantId: string, key: string) {
    const r = await h.asTenant(tenantId, () =>
      h.prisma.tenant.role.findUniqueOrThrow({
        where: { tenantId_key: { tenantId, key } },
        include: { permissions: true },
      }),
    );
    return {
      id: r.id,
      version: r.permissionsVersion,
      permissions: r.permissions.map((p) => p.permission).sort(),
    };
  }

  async function catalogOf(tenantId: string) {
    const rows = await h.asTenant(tenantId, () =>
      h.prisma.tenant.tenantPermissionCatalog.findMany(),
    );
    return new Map(rows.map((r) => [r.permission, r.firstSeenAt]));
  }

  /** A grant as an earlier catalog allowed it: no kind check. */
  async function grantByHand(
    tenantId: string,
    key: string,
    permission: string,
  ) {
    const { id } = await role(tenantId, key);
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await tx.rolePermission.create({
          data: { tenantId, roleId: id, permission },
        });
        await tx.role.update({
          where: { id },
          data: { permissionsVersion: { increment: 1 } },
        });
      }),
    );
  }

  /** What a manager does by hand through RolesService, minus the checks. */
  async function removeByHand(
    tenantId: string,
    key: string,
    permission: string,
  ) {
    const { id } = await role(tenantId, key);
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await tx.rolePermission.delete({
          where: { roleId_permission: { roleId: id, permission } },
        });
        await tx.role.update({
          where: { id },
          data: { permissionsVersion: { increment: 1 } },
        });
      }),
    );
  }

  it('the simulated catalogs are themselves consistent', () => {
    for (const c of [withExport, renamed, retired])
      expect(catalogProblems(c)).toEqual([]);
  });

  it('a new code permission reaches the default roles that include it', async () => {
    const t = await createTenant(h, 'Sync new');
    const before = {
      manager: await role(t, 'manager'),
      resident: await role(t, 'resident'),
    };

    const report = await sync(withExport, t);

    expect(report.added).toEqual(['units.export']);
    const manager = await role(t, 'manager');
    const resident = await role(t, 'resident');
    expect(manager.permissions).toContain('units.export');
    expect(resident.permissions).not.toContain('units.export');
    expect(manager.version).toBe(before.manager.version + 1);
    expect(resident.version).toBe(before.resident.version);
    expect((await catalogOf(t)).has('units.export')).toBe(true);
  });

  it('a permission the manager removed is not re-added', async () => {
    const t = await createTenant(h, 'Sync manual');
    await sync(withExport, t);
    await removeByHand(t, 'manager', 'units.export');
    await removeByHand(t, 'manager', 'units.create');

    const report = await sync(withExport, t);

    expect(report.added).toEqual([]);
    const manager = await role(t, 'manager');
    expect(manager.permissions).not.toContain('units.export');
    expect(manager.permissions).not.toContain('units.create');
  });

  it('a default role added after a compound was created is created with ALL its permissions', async () => {
    // The catalog as it was before Phase 2: no family role, no household or
    // settings permissions.
    const later = [
      'household.manage',
      'household.approve',
      'household.delegate',
      'settings.manage',
      'workers.manage',
      'workers.review',
      'workers.ban',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !later.includes(p)),
      ),
      defaultRoles: base.defaultRoles
        .filter((r) => r.key !== 'family_member')
        .map((r) => ({
          ...r,
          permissions: r.permissions.filter((p) => !later.includes(p)),
        })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync old compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect(report.rolesCreated).toEqual(['family_member']);
    // units.read was offered long ago, yet the new role has it.
    expect((await role(t, 'family_member')).permissions).toEqual([
      'community.read',
      'emergencies.report',
      'facilities.book',
      'gate_services.request',
      'household.manage',
      'neighbours.board',
      'neighbours.complain',
      'parking.report',
      'partners.request',
      'permits.request',
      'profile.contact',
      'profile.photo',
      'requests.create',
      'suggestions.create',
      'tickets.create',
      'units.read',
      'vehicles.register',
      'visitors.invite',
      'workers.manage',
    ]);
    expect((await role(t, 'resident')).permissions).toContain(
      'household.manage',
    );
    expect((await role(t, 'manager')).permissions).toEqual(
      expect.arrayContaining(['household.approve', 'settings.manage']),
    );

    const familyRole = await role(t, 'family_member');
    const [entry] = await h.asTenant(t, () =>
      h.prisma.tenant.auditLog.findMany({
        where: { action: 'role.permissions_synced', targetId: familyRole.id },
      }),
    );
    expect(entry).toMatchObject({
      actorType: 'system',
      changes: {
        permissions: {
          from: [],
          to: [
            'community.read',
            'emergencies.report',
            'facilities.book',
            'gate_services.request',
            'household.manage',
            'neighbours.board',
            'neighbours.complain',
            'parking.report',
            'partners.request',
            'permits.request',
            'profile.contact',
            'profile.photo',
            'requests.create',
            'suggestions.create',
            'tickets.create',
            'units.read',
            'vehicles.register',
            'visitors.invite',
            'workers.manage',
          ],
        },
      },
      metadata: { roleKey: 'family_member', roleCreated: true },
    });

    // A rerun creates nothing.
    expect(await sync(base, t)).toMatchObject({
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('Phase 2.2 permissions reach an existing compound: the manager role only, once', async () => {
    const phase22 = [
      'household.override',
      'workers.compliance',
      'workers.incidents',
      'accounts.erase',
      'accounts.legal_hold',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !phase22.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !phase22.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync 2.2 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );
    const residentBefore = await role(t, 'resident');

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...phase22].sort());
    expect((await role(t, 'manager')).permissions).toEqual(
      expect.arrayContaining(phase22),
    );
    expect((await role(t, 'resident')).permissions).toEqual(
      residentBefore.permissions,
    );
    // A manager who drops one keeps it dropped.
    await removeByHand(t, 'manager', 'workers.compliance');
    expect((await sync(base, t)).added).toEqual([]);
    expect((await role(t, 'manager')).permissions).not.toContain(
      'workers.compliance',
    );
  });

  it('Phase 4 reaches an existing compound: the gate permissions and the guard role (ADR 0028)', async () => {
    const phase4 = [
      'gate.operate',
      'gate.manage',
      'gate.read',
      'visitors.invite',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !phase4.includes(p)),
      ),
      // A compound from before Phase 4 had no staff role at all.
      defaultRoles: base.defaultRoles
        .filter((r) => r.kind !== 'staff')
        .map((r) => ({
          ...r,
          permissions: r.permissions.filter((p) => !phase4.includes(p)),
        })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync 4 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...phase4].sort());
    expect(report.rolesCreated).toEqual([
      'guard',
      'security_supervisor',
      'technician',
      'maintenance_supervisor',
      'accountant',
    ]);
    expect((await role(t, 'guard')).permissions).toEqual(GUARD);
    expect((await role(t, 'manager')).permissions).toEqual(
      expect.arrayContaining(['gate.manage', 'gate.read']),
    );
    for (const key of ['resident', 'family_member']) {
      expect((await role(t, key)).permissions).toContain('visitors.invite');
      expect((await role(t, key)).permissions).not.toContain('gate.operate');
    }
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('Phase 4.3 reaches an existing compound: profile.photo to residents and family only (ADR 0031)', async () => {
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => p !== 'profile.photo'),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => p !== 'profile.photo'),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync 4.3 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect(report.added).toEqual(['profile.photo']);
    for (const key of ['resident', 'family_member'])
      expect((await role(t, key)).permissions).toContain('profile.photo');
    for (const key of ['manager', 'guard'])
      expect((await role(t, key)).permissions).not.toContain('profile.photo');
    // A resident role that dropped it by hand keeps it dropped.
    await removeByHand(t, 'resident', 'profile.photo');
    expect((await sync(base, t)).added).toEqual([]);
    expect((await role(t, 'resident')).permissions).not.toContain(
      'profile.photo',
    );
  });

  it('Phase G1 reaches an existing compound: parcels.handle for the guard, parcels.manage for the manager (ADR 0035)', async () => {
    const g1 = ['parcels.handle', 'parcels.manage'];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !g1.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !g1.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync G1 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...g1].sort());
    expect((await role(t, 'guard')).permissions).toEqual(GUARD);
    expect((await role(t, 'manager')).permissions).toContain('parcels.manage');
    // The other staff roles and the residents do not get them.
    for (const key of ['resident', 'family_member', 'technician']) {
      expect((await role(t, key)).permissions).not.toContain('parcels.handle');
      expect((await role(t, key)).permissions).not.toContain('parcels.manage');
    }
    // A manager who dropped it by hand keeps it dropped.
    await removeByHand(t, 'manager', 'parcels.manage');
    expect((await sync(base, t)).added).toEqual([]);
    expect((await role(t, 'manager')).permissions).not.toContain(
      'parcels.manage',
    );
  });

  it('Phase R2 reaches an existing compound: requests.create for residents and family, handle and manage for the manager (ADR 0039)', async () => {
    const r2 = ['requests.create', 'requests.handle', 'requests.manage'];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r2.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !r2.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync R2 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...r2].sort());
    for (const key of ['resident', 'family_member']) {
      const { permissions } = await role(t, key);
      expect(permissions).toContain('requests.create');
      expect(permissions).not.toContain('requests.handle');
      expect(permissions).not.toContain('requests.manage');
    }
    expect((await role(t, 'manager')).permissions).toEqual(
      expect.arrayContaining(['requests.handle', 'requests.manage']),
    );
    expect((await role(t, 'manager')).permissions).not.toContain(
      'requests.create',
    );
    // No staff role handles requests until a manager says so.
    for (const key of ['guard', 'technician', 'maintenance_supervisor']) {
      for (const permission of r2)
        expect((await role(t, key)).permissions).not.toContain(permission);
    }
    // A manager who dropped it by hand keeps it dropped.
    await removeByHand(t, 'manager', 'requests.manage');
    expect((await sync(base, t)).added).toEqual([]);
    expect((await role(t, 'manager')).permissions).not.toContain(
      'requests.manage',
    );
  });

  it('Phase R3 reaches an existing compound: community.read and suggestions.create for residents and family, publish and suggestions for the manager (ADR 0040)', async () => {
    const r3 = [
      'community.read',
      'suggestions.create',
      'community.publish',
      'community.suggestions',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r3.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !r3.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync R3 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...r3].sort());
    for (const key of ['resident', 'family_member']) {
      const { permissions } = await role(t, key);
      expect(permissions).toEqual(
        expect.arrayContaining(['community.read', 'suggestions.create']),
      );
      expect(permissions).not.toContain('community.publish');
      expect(permissions).not.toContain('community.suggestions');
    }
    const manager = (await role(t, 'manager')).permissions;
    expect(manager).toEqual(
      expect.arrayContaining(['community.publish', 'community.suggestions']),
    );
    expect(manager).not.toContain('community.read');
    expect(manager).not.toContain('suggestions.create');
    // No staff role publishes or handles suggestions until a manager says so.
    for (const key of ['guard', 'technician', 'maintenance_supervisor']) {
      for (const permission of r3)
        expect((await role(t, key)).permissions).not.toContain(permission);
    }
    // A manager who dropped it by hand keeps it dropped.
    await removeByHand(t, 'manager', 'community.suggestions');
    expect((await sync(base, t)).added).toEqual([]);
    expect((await role(t, 'manager')).permissions).not.toContain(
      'community.suggestions',
    );
  });

  it('Phase R4 reaches an existing compound: complain and board for residents and family, handle and manage for the manager (ADR 0042)', async () => {
    const r4 = [
      'neighbours.complain',
      'neighbours.board',
      'neighbours.handle',
      'neighbours.manage',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r4.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !r4.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync R4 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...r4].sort());
    for (const key of ['resident', 'family_member']) {
      const { permissions } = await role(t, key);
      expect(permissions).toEqual(
        expect.arrayContaining(['neighbours.complain', 'neighbours.board']),
      );
      expect(permissions).not.toContain('neighbours.handle');
      expect(permissions).not.toContain('neighbours.manage');
    }
    const manager = (await role(t, 'manager')).permissions;
    expect(manager).toEqual(
      expect.arrayContaining(['neighbours.handle', 'neighbours.manage']),
    );
    expect(manager).not.toContain('neighbours.complain');
    expect(manager).not.toContain('neighbours.board');
    // No staff role handles complaints or the desk until a manager says so.
    for (const key of ['guard', 'technician', 'maintenance_supervisor']) {
      for (const permission of r4)
        expect((await role(t, key)).permissions).not.toContain(permission);
    }
    // A manager who dropped it by hand keeps it dropped.
    await removeByHand(t, 'manager', 'neighbours.manage');
    expect((await sync(base, t)).added).toEqual([]);
    expect((await role(t, 'manager')).permissions).not.toContain(
      'neighbours.manage',
    );
  });

  it('Phase R5 reaches an existing compound: facilities.book for residents and family, the three facilities permissions for the manager, and the accountant role (ADR 0044)', async () => {
    const r5 = [
      'facilities.book',
      'facilities.manage',
      'bookings.handle',
      'club.billing',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r5.includes(p)),
      ),
      defaultRoles: base.defaultRoles
        .filter((r) => r.key !== 'accountant')
        .map((r) => ({
          ...r,
          permissions: r.permissions.filter((p) => !r5.includes(p)),
        })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync R5 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...r5].sort());
    expect(report.rolesCreated).toEqual(['accountant']);
    // The role as the code has it now: the fines' payments came with G2,
    // finance with R6a, its reports with R6b, the budget and the board's
    // approvals with R7b.
    expect([...(await role(t, 'accountant')).permissions].sort()).toEqual([
      'club.billing',
      'finance.billing',
      'finance.budget',
      'finance.invoice',
      'finance.payments',
      'finance.reports',
      'fines.billing',
      'governance.approvals',
    ]);
    for (const key of ['resident', 'family_member']) {
      const { permissions } = await role(t, key);
      expect(permissions).toContain('facilities.book');
      for (const p of ['facilities.manage', 'bookings.handle', 'club.billing'])
        expect(permissions).not.toContain(p);
    }
    const manager = (await role(t, 'manager')).permissions;
    expect(manager).toEqual(
      expect.arrayContaining([
        'facilities.manage',
        'bookings.handle',
        'club.billing',
      ]),
    );
    expect(manager).not.toContain('facilities.book');
    // No other staff role works bookings or the club until a manager says so.
    for (const key of ['guard', 'technician', 'maintenance_supervisor']) {
      for (const permission of r5)
        expect((await role(t, key)).permissions).not.toContain(permission);
    }
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('Phase G2 reaches an existing compound: vehicles.register and parking.report for residents and family, the four vehicles permissions for the manager, fines.billing for the accountant (ADR 0045)', async () => {
    const g2 = [
      'vehicles.register',
      'parking.report',
      'vehicles.manage',
      'fines.issue',
      'fines.billing',
      'parking_reports.handle',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !g2.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !g2.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync G2 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );
    expect([...(await role(t, 'accountant')).permissions].sort()).toEqual([
      'club.billing',
      'finance.billing',
      'finance.budget',
      'finance.invoice',
      'finance.payments',
      'finance.reports',
      'governance.approvals',
    ]);

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...g2].sort());
    expect(report.rolesCreated).toEqual([]);
    expect([...(await role(t, 'accountant')).permissions].sort()).toEqual([
      'club.billing',
      'finance.billing',
      'finance.budget',
      'finance.invoice',
      'finance.payments',
      'finance.reports',
      'fines.billing',
      'governance.approvals',
    ]);
    for (const key of ['resident', 'family_member']) {
      const { permissions } = await role(t, key);
      expect(permissions).toEqual(
        expect.arrayContaining(['vehicles.register', 'parking.report']),
      );
      for (const p of g2.slice(2)) expect(permissions).not.toContain(p);
    }
    const manager = (await role(t, 'manager')).permissions;
    expect(manager).toEqual(expect.arrayContaining(g2.slice(2)));
    expect(manager).not.toContain('vehicles.register');
    expect(manager).not.toContain('parking.report');
    // The guard looks plates up with gate.operate and closes the reports
    // (G4, ADR 0050); no other staff role works vehicles, fines or reports
    // until a manager says so.
    for (const key of ['guard', 'technician', 'maintenance_supervisor']) {
      for (const permission of g2) {
        if (key === 'guard' && permission === 'parking_reports.handle')
          continue;
        expect((await role(t, key)).permissions).not.toContain(permission);
      }
    }
    expect((await role(t, 'guard')).permissions).toEqual(GUARD);
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('Phase R6a reaches an existing compound: the four finance permissions for the manager, billing, invoices and payments for the accountant (ADR 0046)', async () => {
    const r6a = [
      'finance.gateway',
      'finance.billing',
      'finance.invoice',
      'finance.payments',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r6a.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !r6a.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync R6a compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...r6a].sort());
    expect(report.rolesCreated).toEqual([]);
    expect(
      (await role(t, 'accountant')).permissions.filter((p) =>
        p.startsWith('finance.'),
      ),
    ).toEqual(
      expect.arrayContaining([
        'finance.billing',
        'finance.invoice',
        'finance.payments',
      ]),
    );
    expect((await role(t, 'accountant')).permissions).not.toContain(
      'finance.gateway',
    );
    expect((await role(t, 'manager')).permissions).toEqual(
      expect.arrayContaining(r6a),
    );
    // Residents see and pay through capabilities, never a permission; no
    // other staff role touches money until a manager says so.
    for (const key of [
      'resident',
      'family_member',
      'guard',
      'technician',
      'maintenance_supervisor',
    ]) {
      for (const permission of r6a)
        expect((await role(t, key)).permissions).not.toContain(permission);
    }
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('Phase R6b reaches an existing compound: refunds and reports for the manager, reports for the accountant (ADR 0048)', async () => {
    const r6b = ['finance.refund', 'finance.reports'];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r6b.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !r6b.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync R6b compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...r6b].sort());
    expect(report.rolesCreated).toEqual([]);
    expect((await role(t, 'manager')).permissions).toEqual(
      expect.arrayContaining(r6b),
    );
    const accountant = (await role(t, 'accountant')).permissions;
    expect(accountant).toContain('finance.reports');
    // A refund pays money out: the manager's alone, after a step-up.
    expect(accountant).not.toContain('finance.refund');
    for (const key of [
      'resident',
      'family_member',
      'guard',
      'technician',
      'maintenance_supervisor',
    ]) {
      for (const permission of r6b)
        expect((await role(t, key)).permissions).not.toContain(permission);
    }
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('Phase 5.1 reaches an existing compound: ticket permissions and the two maintenance roles (ADR 0032)', async () => {
    const phase51 = [
      'tickets.create',
      'tickets.work',
      'tickets.dispatch',
      'maintenance.manage',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !phase51.includes(p)),
      ),
      defaultRoles: base.defaultRoles
        .filter(
          (r) => !['technician', 'maintenance_supervisor'].includes(r.key),
        )
        .map((r) => ({
          ...r,
          permissions: r.permissions.filter((p) => !phase51.includes(p)),
        })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync 5.1 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        // The domains' rows, as the migrations' backfills gave it.
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...phase51].sort());
    expect(report.rolesCreated).toEqual([
      'technician',
      'maintenance_supervisor',
    ]);
    // Created as the catalog has them now: with the asset register and the
    // inspections they gained in M1-1 (ADR 0064), and the store (ADR 0065).
    expect((await role(t, 'technician')).permissions).toEqual([
      'assets.read',
      'inspections.perform',
      'meters.record',
      'tickets.work',
    ]);
    expect((await role(t, 'maintenance_supervisor')).permissions).toEqual([
      'assets.manage',
      'assets.read',
      'energy.manage',
      'energy.read',
      'inspections.manage',
      'meters.record',
      'readiness.manage',
      'safety.manage',
      'stock.manage',
      'tickets.dispatch',
    ]);
    expect((await role(t, 'manager')).permissions).toEqual(
      expect.arrayContaining(['tickets.dispatch', 'maintenance.manage']),
    );
    for (const key of ['resident', 'family_member']) {
      expect((await role(t, key)).permissions).toContain('tickets.create');
      expect((await role(t, key)).permissions).not.toContain('tickets.work');
    }
    expect((await role(t, 'guard')).permissions).toEqual(GUARD);
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('a second run is a no-op', async () => {
    const t = await createTenant(h, 'Sync idempotent');
    await sync(withExport, t);
    const before = await role(t, 'manager');

    const report = await sync(withExport, t);

    expect(report).toMatchObject({
      added: [],
      renamed: [],
      retired: [],
      unknown: [],
      rolesChanged: 0,
    });
    expect(await role(t, 'manager')).toEqual(before);
  });

  it('a rename moves assignments as they are, keeping manual removals', async () => {
    const kept = await createTenant(h, 'Sync rename kept');
    const removed = await createTenant(h, 'Sync rename removed');
    await removeByHand(removed, 'manager', 'units.create');
    const firstSeen = (await catalogOf(kept)).get('units.create');

    for (const t of [kept, removed]) {
      const report = await sync(renamed, t);
      expect(report.renamed).toEqual(['units.create->units.add']);
      expect(report.added).toEqual([]);
    }

    expect((await role(kept, 'manager')).permissions).toContain('units.add');
    expect((await role(kept, 'manager')).permissions).not.toContain(
      'units.create',
    );
    // The manager's removal survives the rename: the new name is not re-granted.
    expect((await role(removed, 'manager')).permissions).not.toContain(
      'units.add',
    );

    const catalog = await catalogOf(kept);
    expect(catalog.has('units.create')).toBe(false);
    expect(catalog.get('units.add')).toEqual(firstSeen);
    // And a rerun changes nothing.
    expect(await sync(renamed, kept)).toMatchObject({
      renamed: [],
      added: [],
      rolesChanged: 0,
    });
  });

  it('a retired permission is purged from roles and the catalog', async () => {
    const t = await createTenant(h, 'Sync retire');
    const before = await role(t, 'manager');

    const report = await sync(retired, t);

    expect(report.retired).toEqual(['accounts.read']);
    const manager = await role(t, 'manager');
    expect(manager.permissions).not.toContain('accounts.read');
    expect(manager.version).toBe(before.version + 1);
    expect((await catalogOf(t)).has('accounts.read')).toBe(false);
  });

  it('a grant the role’s kind may no longer hold is revoked, once, and reported', async () => {
    const t = await createTenant(h, 'Sync narrowed');
    const other = await createTenant(h, 'Sync narrowed other');
    // What the role editor allowed while `gate.read` listed `resident`.
    await grantByHand(t, 'resident', 'gate.read');
    const before = {
      resident: await role(t, 'resident'),
      manager: await role(t, 'manager'),
      family: await role(t, 'family_member'),
    };
    expect(before.resident.permissions).toContain('gate.read');
    const calls: { roleId: string; added: string[]; removed: string[] }[] = [];
    const lifecycle = new RoleLifecycle();
    lifecycle.onPermissionsChanged((_tx, roleId, added, removed) => {
      calls.push({ roleId, added: [...added], removed: [...removed] });
      return Promise.resolve();
    });

    const report = await sync(base, t, lifecycle);

    expect(report).toMatchObject({
      added: [],
      renamed: [],
      retired: [],
      unknown: [],
      revoked: [
        { roleKey: 'resident', kind: 'resident', permission: 'gate.read' },
      ],
      rolesChanged: 1,
    });
    const resident = await role(t, 'resident');
    expect(resident.permissions).toEqual(
      before.resident.permissions.filter((p) => p !== 'gate.read'),
    );
    expect(resident.version).toBe(before.resident.version + 1);
    // The manager keeps it; no other role is touched.
    expect(await role(t, 'manager')).toEqual(before.manager);
    expect(await role(t, 'family_member')).toEqual(before.family);
    expect(calls).toEqual([
      { roleId: resident.id, added: [], removed: ['gate.read'] },
    ]);
    const audit = await h.asTenant(t, () =>
      h.prisma.tenant.auditLog.findMany({
        where: { action: 'role.permissions_synced', targetId: resident.id },
      }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      roleKey: 'resident',
      revoked: ['gate.read'],
    });

    // Idempotent: nothing left to revoke, nobody told, no new version.
    calls.length = 0;
    const again = await sync(base, t, lifecycle);
    expect(again).toMatchObject({ revoked: [], rolesChanged: 0 });
    expect(await role(t, 'resident')).toEqual(resident);
    expect(calls).toEqual([]);
    // And a compound with no such grant reports none.
    expect(await sync(base, other)).toMatchObject({
      revoked: [],
      rolesChanged: 0,
    });
  });

  it('a permission unknown to code is not revoked by kind', async () => {
    const t = await createTenant(h, 'Sync narrowed unknown');
    await grantByHand(t, 'resident', 'units.export');

    const report = await sync(base, t);

    expect(report).toMatchObject({ revoked: [], unknown: ['units.export'] });
    expect((await role(t, 'resident')).permissions).toContain('units.export');
  });

  it('tells the domains what each role gained and lost, in the sync’s transaction (ADR 0033)', async () => {
    const t = await createTenant(h, 'Sync hook');
    const manager = await role(t, 'manager');
    const calls: { roleId: string; added: string[]; removed: string[] }[] = [];
    const lifecycle = new RoleLifecycle();
    lifecycle.onPermissionsChanged((_tx, roleId, added, removed) => {
      calls.push({ roleId, added: [...added], removed: [...removed] });
      return Promise.resolve();
    });
    await sync(retired, t, lifecycle);
    // Every default role that held accounts.read lost it; none gained anything.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.removed.join() === 'accounts.read')).toBe(true);
    expect(calls.every((c) => c.added.length === 0)).toBe(true);
    expect(calls.map((c) => c.roleId)).toContain(manager.id);
    // A second run changes nothing, so tells nobody.
    calls.length = 0;
    await sync(retired, t, lifecycle);
    expect(calls).toEqual([]);
  });

  it('a rollback leaves unknown permissions alone, and a roll-forward does not re-grant them', async () => {
    const t = await createTenant(h, 'Sync rollback');
    await sync(withExport, t); // deploy N+1 adds units.export

    const rolledBack = await sync(base, t); // back to deploy N: units.export is unknown
    expect(rolledBack.unknown).toEqual(['units.export']);
    expect(rolledBack.retired).toEqual([]);
    expect((await role(t, 'manager')).permissions).toContain('units.export');
    expect((await catalogOf(t)).has('units.export')).toBe(true);

    await removeByHand(t, 'manager', 'units.export'); // the manager removes it meanwhile
    const forward = await sync(withExport, t); // deploy N+1 again
    expect(forward.added).toEqual([]);
    expect((await role(t, 'manager')).permissions).not.toContain(
      'units.export',
    );
  });

  it('only touches the compound being synced', async () => {
    const a = await createTenant(h, 'Sync A');
    const b = await createTenant(h, 'Sync B');
    await sync(withExport, a);
    expect((await role(b, 'manager')).permissions).not.toContain(
      'units.export',
    );
    expect((await catalogOf(b)).has('units.export')).toBe(false);
  });

  it('Phase G6a reaches an existing compound: reporting and requests for residents and family, managing emergencies and handling the requests for the manager; the guard keeps its two (ADR 0047)', async () => {
    const g6a = [
      'emergencies.report',
      'gate_services.request',
      'emergencies.respond',
      'emergencies.manage',
      'gate_services.handle',
    ];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !g6a.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !g6a.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync G6a compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    // emergencies.respond is offered, and no default role holds it: a
    // compound gives it to a role of its own (a control room).
    expect([...report.added].sort()).toEqual([...g6a].sort());
    expect(report.rolesCreated).toEqual([]);
    for (const key of ['resident', 'family_member']) {
      const { permissions } = await role(t, key);
      expect(permissions).toEqual(
        expect.arrayContaining(['emergencies.report', 'gate_services.request']),
      );
      for (const p of g6a.slice(2)) expect(permissions).not.toContain(p);
    }
    const manager = (await role(t, 'manager')).permissions;
    expect(manager).toEqual(
      expect.arrayContaining(['emergencies.manage', 'gate_services.handle']),
    );
    for (const p of [
      'emergencies.report',
      'gate_services.request',
      'emergencies.respond',
    ])
      expect(manager).not.toContain(p);
    // A guard responds with gate.operate inside a shift.
    expect((await role(t, 'guard')).permissions).toEqual(GUARD);
    for (const key of ['technician', 'maintenance_supervisor', 'accountant'])
      for (const permission of g6a)
        expect((await role(t, key)).permissions).not.toContain(permission);
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('Phase G3 reaches an existing compound: permits.request for residents and family, permits.manage for the manager; the guard keeps its own (ADR 0049)', async () => {
    const g3 = ['permits.request', 'permits.manage'];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !g3.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !g3.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync G3 compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...g3].sort());
    expect(report.rolesCreated).toEqual([]);
    for (const key of ['resident', 'family_member']) {
      const { permissions } = await role(t, key);
      expect(permissions).toContain('permits.request');
      expect(permissions).not.toContain('permits.manage');
    }
    const manager = (await role(t, 'manager')).permissions;
    expect(manager).toContain('permits.manage');
    expect(manager).not.toContain('permits.request');
    // A guard sees and records permits with gate.operate inside a shift.
    expect((await role(t, 'guard')).permissions).toEqual(GUARD);
    for (const key of ['technician', 'maintenance_supervisor', 'accountant'])
      for (const permission of g3)
        expect((await role(t, key)).permissions).not.toContain(permission);
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  describe('Phase G4 (ADR 0050)', () => {
    const g4 = [
      'guard_roster.manage',
      'guard_tasks.manage',
      'guard_instructions.manage',
      'guard_reports.read',
      'found_items.manage',
    ];
    /** The catalog before G4: no G4 permission, no supervisor, the guard's two. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !g4.includes(p)),
      ),
      defaultRoles: base.defaultRoles
        .filter((r) => r.key !== 'security_supervisor')
        .map((r) => ({
          ...r,
          permissions: r.permissions.filter(
            (p) =>
              !g4.includes(p) &&
              !(r.key === 'guard' && p === 'parking_reports.handle'),
          ),
        })),
    };

    async function compound(label: string): Promise<string> {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync G4 ${label} ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      return t;
    }

    it('reaches an existing compound: the five permissions for the manager, the security supervisor created with four; the guard is left to the migration', async () => {
      const t = await compound('sync');
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual([...g4].sort());
      expect(report.rolesCreated).toEqual(['security_supervisor']);
      expect((await role(t, 'manager')).permissions).toEqual(
        expect.arrayContaining(g4),
      );
      expect(
        [...(await role(t, 'security_supervisor')).permissions].sort(),
      ).toEqual([
        // Created from today's catalog: G5's patrols (ADR 0052), G6b's
        // security permissions (ADR 0053), O1's devices (ADR 0057) and the
        // units' list too, sorted with the G4 four.
        'blocklist.manage',
        'gate_devices.manage',
        'guard_instructions.manage',
        'guard_reports.read',
        'guard_roster.manage',
        'guard_tasks.manage',
        'incidents.manage',
        'patrols.manage',
        'units.directory',
        'violations.manage',
      ]);
      // parking_reports.handle was offered with G2: the sync never grants
      // an offered permission again.
      expect((await role(t, 'guard')).permissions).toEqual([
        'gate.operate',
        'parcels.handle',
      ]);
      for (const key of [
        'resident',
        'family_member',
        'technician',
        'maintenance_supervisor',
        'accountant',
      ])
        for (const permission of g4)
          expect((await role(t, key)).permissions).not.toContain(permission);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });

    it('the migration grants parking_reports.handle to each system guard role once, bumping its version, and touches no other role', async () => {
      const t = await compound('migration');
      await sync(base, t);
      const custom = newId();
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx((tx) =>
          tx.role.create({
            data: {
              id: custom,
              tenantId: t,
              key: 'night_guard',
              name: 'Night',
              kind: 'staff',
            },
          }),
        ),
      );
      const versions = async () =>
        Object.fromEntries(
          (
            await h.asTenant(t, () =>
              h.tenantTx.withTenantTx((tx) =>
                tx.role.findMany({
                  select: { key: true, permissionsVersion: true },
                }),
              ),
            )
          ).map((r) => [r.key, r.permissionsVersion]),
        );
      const sql = readFileSync(
        join(
          __dirname,
          '../../prisma/migrations/20261028090000_guard_parking_reports/migration.sql',
        ),
        'utf8',
      );
      const was = await versions();
      const migrator = new Client({
        connectionString: process.env.TEST_MIGRATOR_DATABASE_URL,
      });
      await migrator.connect();
      try {
        await migrator.query('BEGIN');
        await migrator.query(sql);
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          t,
        ]);
        const read = async () =>
          (
            await migrator.query<{
              key: string;
              permission: string | null;
              v: number;
            }>(
              `SELECT r.key, rp.permission, r.permissions_version AS v
                 FROM roles r
                 LEFT JOIN role_permissions rp
                   ON rp.role_id = r.id AND rp.permission = 'parking_reports.handle'
                WHERE r.tenant_id = $1::uuid`,
              [t],
            )
          ).rows;
        const once = await read();
        const by = (key: string) => once.find((r) => r.key === key)!;
        expect(by('guard')).toEqual({
          key: 'guard',
          permission: 'parking_reports.handle',
          v: was.guard + 1,
        });
        expect(by('night_guard').permission).toBeNull();
        for (const r of once.filter(
          (r) => !['guard', 'manager'].includes(r.key),
        ))
          expect(r.v).toBe(was[r.key]);
        // The manager holds it already (G2): unchanged.
        expect(by('manager').v).toBe(was.manager);
        // A second run finds nothing to grant.
        await migrator.query(sql);
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          t,
        ]);
        expect(await read()).toEqual(once);
      } finally {
        await migrator.query('ROLLBACK');
        await migrator.end();
      }
    });
  });

  it('Phase R7a reaches an existing compound: governance.read for residents, governance.manage for the manager; governance.board, derived from a seat, goes to no role (ADR 0051)', async () => {
    const r7a = ['governance.read', 'governance.board', 'governance.manage'];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r7a.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !r7a.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync R7a compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...r7a].sort());
    expect(report.rolesCreated).toEqual([]);
    expect((await role(t, 'resident')).permissions).toContain(
      'governance.read',
    );
    expect((await role(t, 'manager')).permissions).toContain(
      'governance.manage',
    );
    // A family member never owns the unit; a staff role never votes.
    for (const key of [
      'family_member',
      'guard',
      'technician',
      'maintenance_supervisor',
      'accountant',
      'security_supervisor',
    ])
      for (const permission of r7a)
        expect((await role(t, key)).permissions).not.toContain(permission);
    for (const key of ['resident', 'manager'])
      expect((await role(t, key)).permissions).not.toContain(
        'governance.board',
      );
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  it('Phase R7b reaches an existing compound: governance.approvals and finance.budget for the manager and the accountant, nobody else (ADR 0055)', async () => {
    const r7b = ['governance.approvals', 'finance.budget'];
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r7b.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !r7b.includes(p)),
      })),
    };
    expect(catalogProblems(before)).toEqual([]);
    const t = newId();
    await h.globalDb.tenant.create({
      data: { id: t, name: `Sync R7b compound ${t}` },
    });
    await h.asTenant(t, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        await new RoleProvisioner(before).provision(tx, t);
        await tx.tenantSettings.create({ data: { tenantId: t } });
        await tenantLifecycle.tenantCreated(tx, t);
      }),
    );

    const report = await sync(base, t);
    expect([...report.added].sort()).toEqual([...r7b].sort());
    for (const key of ['manager', 'accountant'])
      for (const permission of r7b)
        expect((await role(t, key)).permissions).toContain(permission);
    for (const key of [
      'resident',
      'family_member',
      'guard',
      'technician',
      'maintenance_supervisor',
      'security_supervisor',
    ])
      for (const permission of r7b)
        expect((await role(t, key)).permissions).not.toContain(permission);
    expect(await sync(base, t)).toMatchObject({
      added: [],
      rolesCreated: [],
      rolesChanged: 0,
    });
  });

  describe('Phase G5 (ADR 0052)', () => {
    /** The catalog before G5: no patrols.manage anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(
          ([p]) => p !== 'patrols.manage',
        ),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => p !== 'patrols.manage'),
      })),
    };

    it('reaches an existing compound: patrols.manage for the manager and the security supervisor, nobody else', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync G5 ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect(report.added).toEqual(['patrols.manage']);
      expect(report.rolesCreated).toEqual([]);
      for (const key of ['manager', 'security_supervisor'])
        expect((await role(t, key)).permissions).toContain('patrols.manage');
      // A guard walks the routes with gate.operate, inside a shift.
      for (const key of [
        'guard',
        'resident',
        'family_member',
        'technician',
        'maintenance_supervisor',
        'accountant',
      ])
        expect((await role(t, key)).permissions).not.toContain(
          'patrols.manage',
        );
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase G6b (ADR 0053)', () => {
    const g6b = [
      'incidents.manage',
      'blocklist.manage',
      'violations.manage',
      'violations.issue',
      'lockdown.end',
    ];
    /** The catalog before G6b: none of its five permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !g6b.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !g6b.includes(p)),
      })),
    };

    it('reaches an existing compound: all five for the manager, three for the security supervisor, nothing for anyone else', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync G6b ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual([...g6b].sort());
      expect(report.rolesCreated).toEqual([]);
      expect((await role(t, 'manager')).permissions).toEqual(
        expect.arrayContaining(g6b),
      );
      const supervisor = (await role(t, 'security_supervisor')).permissions;
      expect(supervisor.filter((p) => g6b.includes(p)).sort()).toEqual([
        'blocklist.manage',
        'incidents.manage',
        'violations.manage',
      ]);
      // A guard reports, issues and locks down with gate.operate, inside a
      // shift; the accountant takes violations' payments with fines.billing.
      for (const key of [
        'guard',
        'resident',
        'family_member',
        'technician',
        'maintenance_supervisor',
        'accountant',
      ])
        expect(
          (await role(t, key)).permissions.filter((p) => g6b.includes(p)),
        ).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase G7 (ADR 0056)', () => {
    const g7 = ['gate_exceptions.decide', 'gate_log.search'];
    /** The catalog before G7: none of its permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !g7.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !g7.includes(p)),
      })),
    };

    it('reaches an existing compound: the manager only', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync G7 ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual([...g7].sort());
      expect(report.rolesCreated).toEqual([]);
      expect((await role(t, 'manager')).permissions).toEqual(
        expect.arrayContaining(g7),
      );
      // A guard asks with gate.operate; the supervisor keeps the guards, not
      // the gate's exceptions.
      for (const key of [
        'guard',
        'security_supervisor',
        'resident',
        'family_member',
        'technician',
        'maintenance_supervisor',
        'accountant',
      ])
        expect(
          (await role(t, key)).permissions.filter((p) => g7.includes(p)),
        ).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase O1 (ADR 0057)', () => {
    const o1 = ['gate_devices.manage'];
    /** The catalog before O1: none of its permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !o1.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !o1.includes(p)),
      })),
    };

    it('reaches an existing compound: the manager and the security supervisor', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync O1 ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual([...o1].sort());
      expect(report.rolesCreated).toEqual([]);
      for (const key of ['manager', 'security_supervisor'])
        expect((await role(t, key)).permissions).toEqual(
          expect.arrayContaining(o1),
        );
      // A guard enrols a device with gate.operate; nobody else keeps them.
      for (const key of [
        'guard',
        'resident',
        'family_member',
        'technician',
        'maintenance_supervisor',
        'accountant',
      ])
        expect(
          (await role(t, key)).permissions.filter((p) => o1.includes(p)),
        ).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe("The units' list for staff (units.directory)", () => {
    const directory = ['units.directory'];
    /** The catalog before it: the permission nowhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(
          ([p]) => !directory.includes(p),
        ),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !directory.includes(p)),
      })),
    };

    it('reaches an existing compound: the security supervisor only', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync units directory ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect(report.added).toEqual(directory);
      expect(report.rolesCreated).toEqual([]);
      expect(report.rolesChanged).toBe(1);
      expect((await role(t, 'security_supervisor')).permissions).toContain(
        'units.directory',
      );
      // The manager lists every unit with units.read; a guard, a technician
      // or the accountant has no use for the list until a manager grants it.
      for (const key of [
        'manager',
        'resident',
        'family_member',
        'guard',
        'technician',
        'maintenance_supervisor',
        'accountant',
      ])
        expect((await role(t, key)).permissions).not.toContain(
          'units.directory',
        );
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase P1 (ADR 0060)', () => {
    const p1 = ['partners.request', 'partners.manage'];
    /** The catalog before P1: none of its permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !p1.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !p1.includes(p)),
      })),
    };

    it('reaches an existing compound: the manager, the residents and the family', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync P1 ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual([...p1].sort());
      expect(report.rolesCreated).toEqual([]);
      expect((await role(t, 'manager')).permissions).toContain(
        'partners.manage',
      );
      for (const key of ['resident', 'family_member'])
        expect((await role(t, key)).permissions).toContain('partners.request');
      // No staff role lists partners until a manager grants it.
      for (const key of [
        'guard',
        'security_supervisor',
        'technician',
        'maintenance_supervisor',
        'accountant',
      ])
        expect(
          (await role(t, key)).permissions.filter((p) => p1.includes(p)),
        ).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase M1-1 (ADR 0064)', () => {
    const m1 = [
      'assets.read',
      'assets.manage',
      'inspections.perform',
      'inspections.manage',
    ];
    /** The catalog before M1-1: none of its permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !m1.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !m1.includes(p)),
      })),
    };

    it('reaches an existing compound: technicians read assets and inspect, the supervisor and the manager keep them', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync M1-1 ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual([...m1].sort());
      expect(report.rolesCreated).toEqual([]);
      const has = async (key: string) =>
        (await role(t, key)).permissions.filter((p) => m1.includes(p)).sort();
      expect(await has('technician')).toEqual([
        'assets.read',
        'inspections.perform',
      ]);
      expect(await has('maintenance_supervisor')).toEqual([
        'assets.manage',
        'assets.read',
        'inspections.manage',
      ]);
      expect(await has('manager')).toEqual([
        'assets.manage',
        'assets.read',
        'inspections.manage',
      ]);
      for (const key of [
        'resident',
        'family_member',
        'guard',
        'security_supervisor',
        'accountant',
      ])
        expect(await has(key)).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase M1-2 (ADR 0065)', () => {
    const m12 = ['stock.manage'];
    /** The catalog before M1-2: none of its permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !m12.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !m12.includes(p)),
      })),
    };

    it('reaches an existing compound: the maintenance supervisor and the manager keep the store, nobody else', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync M1-2 ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual(m12);
      expect(report.rolesCreated).toEqual([]);
      const has = async (key: string) =>
        (await role(t, key)).permissions.filter((p) => m12.includes(p));
      for (const key of ['maintenance_supervisor', 'manager'])
        expect(await has(key)).toEqual(['stock.manage']);
      for (const key of [
        'technician',
        'resident',
        'family_member',
        'guard',
        'security_supervisor',
        'accountant',
      ])
        expect(await has(key)).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase M1-3b (ADR 0067)', () => {
    const m13b = ['readiness.manage', 'safety.manage'];
    /** The catalog before M1-3b: none of its permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !m13b.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !m13b.includes(p)),
      })),
    };

    it('reaches an existing compound: the supervisor and the manager keep readiness and field safety, nobody else', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync M1-3b ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual(m13b);
      expect(report.rolesCreated).toEqual([]);
      const has = async (key: string) =>
        (await role(t, key)).permissions.filter((p) => m13b.includes(p));
      expect(await has('maintenance_supervisor')).toEqual(m13b);
      expect(await has('manager')).toEqual(m13b);
      for (const key of [
        'resident',
        'family_member',
        'guard',
        'security_supervisor',
        'technician',
        'accountant',
      ])
        expect(await has(key)).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase M1-3a (ADR 0066)', () => {
    const m13a = ['energy.manage', 'energy.read', 'meters.record'];
    /** The catalog before M1-3a: none of its permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !m13a.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !m13a.includes(p)),
      })),
    };

    it('reaches an existing compound: the supervisor and the manager read and keep energy, the technician records readings, nobody else', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync M1-3a ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual(m13a);
      expect(report.rolesCreated).toEqual([]);
      const has = async (key: string) =>
        (await role(t, key)).permissions.filter((p) => m13a.includes(p));
      expect(await has('maintenance_supervisor')).toEqual(m13a);
      expect(await has('manager')).toEqual(['energy.manage', 'energy.read']);
      expect(await has('technician')).toEqual(['meters.record']);
      for (const key of [
        'resident',
        'family_member',
        'guard',
        'security_supervisor',
        'accountant',
      ])
        expect(await has(key)).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase R11b-2 (ADR 0059)', () => {
    const r11b2 = ['appeals.decide'];
    /** The catalog before R11b-2: none of its permissions anywhere. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).filter(([p]) => !r11b2.includes(p)),
      ),
      defaultRoles: base.defaultRoles.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !r11b2.includes(p)),
      })),
    };

    it('reaches an existing compound: the manager decides appeals, nobody else', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync R11b-2 ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect([...report.added].sort()).toEqual([...r11b2].sort());
      expect(report.rolesCreated).toEqual([]);
      expect((await role(t, 'manager')).permissions).toContain(
        'appeals.decide',
      );
      for (const key of [
        'resident',
        'family_member',
        'guard',
        'security_supervisor',
        'technician',
        'maintenance_supervisor',
        'accountant',
      ])
        expect(
          (await role(t, key)).permissions.filter((p) => r11b2.includes(p)),
        ).toEqual([]);
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });

  describe('Phase R11a-2 (ADR 0063)', () => {
    const offered = [
      'units.read',
      'community.read',
      'visitors.invite',
      'tickets.create',
      'requests.create',
      'permits.request',
    ];
    /** The catalog before R11a-2: no permission offered to a proxy, no unit_proxy role. */
    const before: AccessCatalog = {
      ...base,
      permissions: Object.fromEntries(
        Object.entries(base.permissions).map(([p, def]) => [
          p,
          { ...def, kinds: def.kinds.filter((k) => k !== 'proxy') },
        ]),
      ),
      defaultRoles: base.defaultRoles.filter((r) => r.key !== 'unit_proxy'),
    };

    it('reaches an existing compound: the unit_proxy role with its six permissions, no new permission, nobody else changed', async () => {
      expect(catalogProblems(before)).toEqual([]);
      const t = newId();
      await h.globalDb.tenant.create({
        data: { id: t, name: `Sync R11a-2 ${t}` },
      });
      await h.asTenant(t, () =>
        h.tenantTx.withTenantTx(async (tx) => {
          await new RoleProvisioner(before).provision(tx, t);
          await tx.tenantSettings.create({ data: { tenantId: t } });
          await tenantLifecycle.tenantCreated(tx, t);
        }),
      );
      const report = await sync(base, t);
      expect(report.added).toEqual([]);
      expect(report.rolesCreated).toEqual(['unit_proxy']);
      const proxy = await role(t, 'unit_proxy');
      expect([...proxy.permissions].sort()).toEqual([...offered].sort());
      expect(await sync(base, t)).toMatchObject({
        added: [],
        rolesCreated: [],
        rolesChanged: 0,
      });
    });
  });
});
