import { Inject, Injectable } from '@nestjs/common';
import type { AccountType } from '@prisma/client';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { TenantTx } from '../database/tenant-tx.service';
import { ACCESS_CATALOG, type AccessCatalog } from './access-catalog';

/** Internal view; HTTP shapes come with the design (Phase 1a has no new endpoints). */
export interface RoleWithPermissions {
  id: string;
  key: string;
  /** Null for system roles: the UI translates by key (ADR 0013). */
  name: string | null;
  kind: AccountType;
  isSystem: boolean;
  permissions: string[];
}

/**
 * A compound's roles (ADR 0010). Callers are guarded by `roles.read` /
 * `roles.manage`; the tenant always comes from the request context.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    @Inject(ACCESS_CATALOG) private readonly catalog: AccessCatalog,
  ) {}

  async list(): Promise<RoleWithPermissions[]> {
    const roles = await this.prisma.tenant.role.findMany({
      include: { permissions: { select: { permission: true } } },
      orderBy: { key: 'asc' },
    });
    return roles.map(toView);
  }

  async get(roleId: string): Promise<RoleWithPermissions> {
    const role = await this.prisma.tenant.role.findUnique({
      where: { id: roleId },
      include: { permissions: { select: { permission: true } } },
    });
    if (!role) throw roleNotFound();
    return toView(role);
  }

  /**
   * Replaces a role's permissions. Applies to every account with the role on
   * its next request: the version bump retires the cached set.
   */
  async replacePermissions(
    roleId: string,
    permissions: readonly string[],
  ): Promise<RoleWithPermissions> {
    const wanted = [...new Set(permissions)].sort();
    const unknown = wanted.filter((p) => !this.catalog.permissions[p]);
    if (unknown.length) {
      throw appError.badRequest(
        ErrorCode.UNKNOWN_PERMISSION,
        `Unknown permissions: ${unknown.join(', ')}`,
        { params: { permissions: unknown } },
      );
    }
    const tenantId = this.ctx.tenantId;

    return this.tenantTx.withTenantTx(async (tx) => {
      // Serialize concurrent edits of the same role.
      await tx.$executeRaw`SELECT 1 FROM roles WHERE id = ${roleId}::uuid FOR UPDATE`;
      const role = await tx.role.findUnique({
        where: { id: roleId },
        include: { permissions: { select: { permission: true } } },
      });
      if (!role) throw roleNotFound();

      const notAssignable = wanted.filter(
        (p) => !this.catalog.permissions[p].kinds.includes(role.kind),
      );
      if (notAssignable.length) {
        throw appError.badRequest(
          ErrorCode.PERMISSION_NOT_ASSIGNABLE,
          `Not assignable to ${role.kind}: ${notAssignable.join(', ')}`,
          { params: { permissions: notAssignable, kind: role.kind } },
        );
      }

      const { lockout } = this.catalog;
      if (role.isSystem && role.key === lockout.roleKey) {
        const missing = lockout.permissions.filter((p) => !wanted.includes(p));
        if (missing.length) {
          throw appError.conflict(
            ErrorCode.ROLE_LOCKOUT,
            `The ${role.key} role must keep: ${missing.join(', ')}`,
            { params: { permissions: missing } },
          );
        }
      }

      const current = new Set(role.permissions.map((p) => p.permission));
      const toAdd = wanted.filter((p) => !current.has(p));
      const toRemove = [...current].filter((p) => !wanted.includes(p));
      if (toAdd.length === 0 && toRemove.length === 0) return toView(role);

      if (toRemove.length) {
        await tx.rolePermission.deleteMany({
          where: { roleId, permission: { in: toRemove } },
        });
      }
      if (toAdd.length) {
        await tx.rolePermission.createMany({
          data: toAdd.map((permission) => ({ tenantId, roleId, permission })),
        });
      }
      const updated = await tx.role.update({
        where: { id: roleId },
        data: { permissionsVersion: { increment: 1 } },
        include: { permissions: { select: { permission: true } } },
      });
      return toView(updated);
    });
  }
}

function toView(role: {
  id: string;
  key: string;
  name: string | null;
  kind: AccountType;
  isSystem: boolean;
  permissions: { permission: string }[];
}): RoleWithPermissions {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    kind: role.kind,
    isSystem: role.isSystem,
    permissions: role.permissions.map((p) => p.permission).sort(),
  };
}

function roleNotFound() {
  return appError.notFound(ErrorCode.ROLE_NOT_FOUND, 'Role not found');
}
