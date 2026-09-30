import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import {
  PlatformAuditQueryService,
  SecurityEventsQueryService,
} from '../audit/audit-query.service';
import {
  PlatformAuditQueryDto,
  SecurityEventsQueryDto,
  window,
} from '../audit/dto/audit-query.dto';
import {
  PlatformAuditEntryView,
  SecurityEventView,
} from '../audit/views/audit.views';
import { ApiArea } from '../common/http/decorators';
import { ListOf, toList, type ListResponse } from '../common/http/list';
import { PlatformAuth } from './platform-auth.guard';

/** The platform owner's audit log and the security events (ADR 0014). */
@ApiArea('platform', 'platform')
@PlatformAuth()
@Controller('platform')
export class PlatformAuditController {
  constructor(
    private readonly audit: PlatformAuditQueryService,
    private readonly events: SecurityEventsQueryService,
  ) {}

  @Get('audit')
  @ApiOkResponse({ type: ListOf(PlatformAuditEntryView) })
  async auditLog(
    @Query() q: PlatformAuditQueryDto,
  ): Promise<ListResponse<PlatformAuditEntryView>> {
    return toList(await this.audit.list({ ...q, ...window(q) }), (e) =>
      PlatformAuditEntryView.fromPlatform(e),
    );
  }

  @Get('security-events')
  @ApiOkResponse({ type: ListOf(SecurityEventView) })
  async securityEvents(
    @Query() q: SecurityEventsQueryDto,
  ): Promise<ListResponse<SecurityEventView>> {
    return toList(await this.events.list({ ...q, ...window(q) }), (e) =>
      SecurityEventView.from(e),
    );
  }
}
