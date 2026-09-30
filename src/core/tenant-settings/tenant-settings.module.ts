import { SettingsController } from './settings.controller';
import { Global, Module } from '@nestjs/common';
import { TenantSettingsService } from './tenant-settings.service';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [TenantSettingsService],
  exports: [TenantSettingsService],
})
export class TenantSettingsModule {}
