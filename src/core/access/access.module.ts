import { RolesController } from './roles.controller';
import { Global, Module } from '@nestjs/common';
import { ACCESS_CATALOG, CODE_ACCESS_CATALOG } from './access-catalog';
import { DerivedGrants } from './derived-grants';
import { PermissionsService } from './permissions.service';
import { RoleProvisioner } from './role-provisioner';
import { ResourceAccess } from './resource-access';
import { RoleLifecycle } from './role-lifecycle';
import { RolesService } from './roles.service';
import { StaffRecipients } from './staff-recipients';
import { DeputiesController } from './deputies.controller';
import { DeputiesService } from './deputies.service';

@Global()
@Module({
  controllers: [RolesController, DeputiesController],
  providers: [
    { provide: ACCESS_CATALOG, useValue: CODE_ACCESS_CATALOG },
    RoleProvisioner,
    DerivedGrants,
    PermissionsService,
    RolesService,
    RoleLifecycle,
    ResourceAccess,
    StaffRecipients,
    DeputiesService,
  ],
  exports: [
    ResourceAccess,
    StaffRecipients,
    ACCESS_CATALOG,
    RoleProvisioner,
    DerivedGrants,
    PermissionsService,
    RolesService,
    RoleLifecycle,
  ],
})
export class AccessModule {}
