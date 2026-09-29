import { Global, Module } from '@nestjs/common';
import { AuditContext } from './audit-context';
import { AuditService } from './audit.service';
import { PlatformAuditService } from './platform-audit.service';
import { SecurityEventsService } from './security-events.service';

@Global()
@Module({
  providers: [
    AuditContext,
    AuditService,
    PlatformAuditService,
    SecurityEventsService,
  ],
  exports: [AuditService, PlatformAuditService, SecurityEventsService],
})
export class AuditModule {}
