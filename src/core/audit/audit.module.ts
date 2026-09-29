import { Global, Module } from '@nestjs/common';
import {
  AuditQueryService,
  PlatformAuditQueryService,
  SecurityEventsQueryService,
} from './audit-query.service';
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
    AuditQueryService,
    PlatformAuditQueryService,
    SecurityEventsQueryService,
  ],
  exports: [
    AuditContext,
    AuditService,
    PlatformAuditService,
    SecurityEventsService,
    AuditQueryService,
    PlatformAuditQueryService,
    SecurityEventsQueryService,
  ],
})
export class AuditModule {}
