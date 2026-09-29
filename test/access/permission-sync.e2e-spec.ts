import { Logger } from '@nestjs/common';
import {
  CODE_ACCESS_CATALOG,
  catalogProblems,
  type AccessCatalog,
} from '../../src/core/access/access-catalog';
import { RoleProvisioner } from '../../src/core/access/role-provisioner';
import { newId } from '../../src/core/common/uuid';
import { PermissionSyncService } from '../../src/core/platform/permission-sync.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createTenant } from '../setup/fixtures';

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

  const sync = (catalog: AccessCatalog, tenantId: string) =>
    new PermissionSyncService(
      catalog,
      h.globalDb,
      h.tenantTx,
      h.audit,
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
      }),
    );

    const report = await sync(base, t);
    expect(report.rolesCreated).toEqual(['family_member']);
    // units.read was offered long ago, yet the new role has it.
    expect((await role(t, 'family_member')).permissions).toEqual([
      'household.manage',
      'units.read',
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
        permissions: { from: [], to: ['household.manage', 'units.read'] },
      },
      metadata: { roleKey: 'family_member', roleCreated: true },
    });

    // A rerun creates nothing.
    expect(await sync(base, t)).toMatchObject({
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
});
