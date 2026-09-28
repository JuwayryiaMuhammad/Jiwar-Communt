import { Global, Module } from '@nestjs/common';
import { ACCESS_CATALOG, CODE_ACCESS_CATALOG } from './access-catalog';
import { PermissionsService } from './permissions.service';
import { RoleProvisioner } from './role-provisioner';

@Global()
@Module({
  providers: [
    { provide: ACCESS_CATALOG, useValue: CODE_ACCESS_CATALOG },
    RoleProvisioner,
    PermissionsService,
  ],
  exports: [ACCESS_CATALOG, RoleProvisioner, PermissionsService],
})
export class AccessModule {}
