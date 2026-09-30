import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea } from '../common/http/decorators';
import { ListOf, toList, type ListResponse } from '../common/http/list';
import { AuditQueryService } from './audit-query.service';
import { AuditQueryDto, window } from './dto/audit-query.dto';
import { AuditEntryView } from './views/audit.views';

/** The compound's audit log (ADR 0014), newest first; no IP, no user agent. */
@ApiArea('admin')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @RequirePermissions('audit.read')
  @Get()
  @ApiOkResponse({ type: ListOf(AuditEntryView) })
  async list(@Query() q: AuditQueryDto): Promise<ListResponse<AuditEntryView>> {
    return toList(await this.audit.list({ ...q, ...window(q) }), (e) =>
      AuditEntryView.from(e),
    );
  }
}
