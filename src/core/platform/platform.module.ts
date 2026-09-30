import { Module } from '@nestjs/common';
import { PlatformAuditController } from './platform-audit.controller';
import { PlatformAuthController } from './platform-auth.controller';
import { TenantsController } from './tenants.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import { PermissionSyncService } from './permission-sync.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformBootstrapService } from './platform-bootstrap.service';
import { PLATFORM_JWT, platformJwtProvider } from './platform-jwt';
import { PlatformSessionService } from './platform-session.service';
import { TenantsService } from './tenants.service';

/** The platform owner's side of the system (ADR 0011), under `/platform`. */
@Module({
  imports: [AccountsModule, AuthModule],
  controllers: [
    PlatformAuthController,
    TenantsController,
    PlatformAuditController,
  ],
  providers: [
    platformJwtProvider,
    PlatformSessionService,
    PlatformAuthService,
    PlatformAuthGuard,
    PlatformBootstrapService,
    PermissionSyncService,
    TenantsService,
  ],
  exports: [
    PLATFORM_JWT,
    PlatformSessionService,
    PlatformAuthService,
    PlatformAuthGuard,
    PermissionSyncService,
    TenantsService,
  ],
})
export class PlatformModule {}
