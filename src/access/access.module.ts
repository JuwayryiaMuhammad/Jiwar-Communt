import { Global, Module } from '@nestjs/common';
import { ACCESS_CATALOG, CODE_ACCESS_CATALOG } from './access-catalog';
import { RoleProvisioner } from './role-provisioner';

@Global()
@Module({
  providers: [
    { provide: ACCESS_CATALOG, useValue: CODE_ACCESS_CATALOG },
    RoleProvisioner,
  ],
  exports: [ACCESS_CATALOG, RoleProvisioner],
})
export class AccessModule {}
