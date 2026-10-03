import { SettingsController } from './settings.controller';
import { Global, Module } from '@nestjs/common';
import { TenantLifecycle } from './tenant-lifecycle';
import { TenantSettingsService } from './tenant-settings.service';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [TenantSettingsService, TenantLifecycle],
  exports: [TenantSettingsService, TenantLifecycle],
})
export class TenantSettingsModule {}
