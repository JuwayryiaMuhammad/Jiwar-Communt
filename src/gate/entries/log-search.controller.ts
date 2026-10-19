import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { LogSearchDto } from './dto/log-search.dto';
import { LogSearchService } from './log-search.service';
import { LogSearchView } from './views/log-search.views';

/**
 * The management's search of the gate log (ADR 0056). A POST so the name
 * travels in a body, never in a URL or an access log; deliberately not
 * `@Idempotent`: a search writes nothing to retry, and an idempotency
 * record would keep the body's name for 24 hours.
 */
@ApiArea('gate')
@RequirePermissions('gate_log.search')
@Controller('staff/gate/log-search')
export class LogSearchController {
  constructor(private readonly search: LogSearchService) {}

  @Post()
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search the gate log',
    description:
      'The compound’s days asked (31 at most), a unit, a visitor named exactly. Every search is audited without the name; 20 searches per 10 minutes (RATE_LIMITED).',
  })
  @ApiOkResponse({ type: LogSearchView })
  async find(@Body() dto: LogSearchDto): Promise<LogSearchView> {
    return LogSearchView.from(await this.search.search(dto));
  }
}
