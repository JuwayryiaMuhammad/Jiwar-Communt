import { Global, Module } from '@nestjs/common';
import { TenantSettingsService } from './tenant-settings.service';

@Global()
@Module({
  providers: [TenantSettingsService],
  exports: [TenantSettingsService],
})
export class TenantSettingsModule {}
