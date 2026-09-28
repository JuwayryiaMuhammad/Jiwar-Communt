import { Module } from '@nestjs/common';
import { PermissionSyncService } from './permission-sync.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformBootstrapService } from './platform-bootstrap.service';
import { PLATFORM_JWT, platformJwtProvider } from './platform-jwt';
import { PlatformSessionService } from './platform-session.service';

/**
 * The platform owner's side of the system (ADR 0011). No controllers yet:
 * endpoints come with the design; services are exercised by tests.
 */
@Module({
  providers: [
    platformJwtProvider,
    PlatformSessionService,
    PlatformAuthService,
    PlatformAuthGuard,
    PlatformBootstrapService,
    PermissionSyncService,
  ],
  exports: [
    PLATFORM_JWT,
    PlatformSessionService,
    PlatformAuthService,
    PlatformAuthGuard,
    PermissionSyncService,
  ],
})
export class PlatformModule {}
