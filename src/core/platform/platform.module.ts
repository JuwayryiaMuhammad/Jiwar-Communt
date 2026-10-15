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
import { PlatformStepUpController } from './platform-step-up.controller';
import { PlatformStepUpService } from './platform-step-up.service';
import { TenantsService } from './tenants.service';

/** The platform owner's side of the system (ADR 0011), under `/platform`. */
@Module({
  imports: [AccountsModule, AuthModule],
  controllers: [
    PlatformAuthController,
    TenantsController,
    PlatformAuditController,
    PlatformStepUpController,
  ],
  providers: [
    platformJwtProvider,
    PlatformSessionService,
    PlatformAuthService,
    PlatformAuthGuard,
    PlatformBootstrapService,
    PermissionSyncService,
    TenantsService,
    PlatformStepUpService,
  ],
  exports: [
    PLATFORM_JWT,
    PlatformSessionService,
    PlatformAuthService,
    PlatformAuthGuard,
    PermissionSyncService,
    TenantsService,
    PlatformStepUpService,
  ],
})
export class PlatformModule {}
