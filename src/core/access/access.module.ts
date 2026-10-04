import { RolesController } from './roles.controller';
import { Global, Module } from '@nestjs/common';
import { ACCESS_CATALOG, CODE_ACCESS_CATALOG } from './access-catalog';
import { PermissionsService } from './permissions.service';
import { RoleProvisioner } from './role-provisioner';
import { ResourceAccess } from './resource-access';
import { RoleLifecycle } from './role-lifecycle';
import { RolesService } from './roles.service';
import { StaffRecipients } from './staff-recipients';

@Global()
@Module({
  controllers: [RolesController],
  providers: [
    { provide: ACCESS_CATALOG, useValue: CODE_ACCESS_CATALOG },
    RoleProvisioner,
    PermissionsService,
    RolesService,
    RoleLifecycle,
    ResourceAccess,
    StaffRecipients,
  ],
  exports: [
    ResourceAccess,
    StaffRecipients,
    ACCESS_CATALOG,
    RoleProvisioner,
    PermissionsService,
    RolesService,
    RoleLifecycle,
  ],
})
export class AccessModule {}
