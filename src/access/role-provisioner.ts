import { Inject, Injectable } from '@nestjs/common';
import { newId } from '../common/uuid';
import type { TenantTxClient } from '../database/tenant-tx.service';
import { ACCESS_CATALOG, type AccessCatalog } from './access-catalog';

/**
 * Gives a new compound its own copy of the default roles and permissions,
 * and records every current permission as already offered (ADR 0010).
 * Works inside the caller's tenant transaction; it never picks a tenant.
 */
@Injectable()
export class RoleProvisioner {
  constructor(
    @Inject(ACCESS_CATALOG) private readonly catalog: AccessCatalog,
  ) {}

  async provision(tx: TenantTxClient, tenantId: string): Promise<void> {
    for (const def of this.catalog.defaultRoles) {
      const roleId = newId();
      await tx.role.create({
        data: {
          id: roleId,
          tenantId,
          key: def.key,
          name: null,
          kind: def.kind,
          isSystem: true,
        },
      });
      if (def.permissions.length) {
        await tx.rolePermission.createMany({
          data: def.permissions.map((permission) => ({
            tenantId,
            roleId,
            permission,
          })),
        });
      }
    }
    await tx.tenantPermissionCatalog.createMany({
      data: Object.keys(this.catalog.permissions).map((permission) => ({
        tenantId,
        permission,
      })),
    });
  }
}
