import { Global, Module } from '@nestjs/common';
import { ACCESS_CATALOG, CODE_ACCESS_CATALOG } from './access-catalog';
import { PermissionsService } from './permissions.service';
import { RoleProvisioner } from './role-provisioner';
import { RolesService } from './roles.service';

@Global()
@Module({
  providers: [
    { provide: ACCESS_CATALOG, useValue: CODE_ACCESS_CATALOG },
    RoleProvisioner,
    PermissionsService,
    RolesService,
  ],
  exports: [ACCESS_CATALOG, RoleProvisioner, PermissionsService, RolesService],
})
export class AccessModule {}
