import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
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

  @Post('export')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export a search of the gate log as CSV',
    description:
      'The same body and rules as the search (ADR 0079): every entry found, newest first, 50 000 at most (EXPORT_TOO_LARGE). Audited without the name; counts against the search’s 20 per 10 minutes. UTF-8 with a byte-order mark, CRLF; text cells guarded against formulas.',
  })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Body() dto: LogSearchDto): Promise<StreamableFile> {
    const { name, body } = await this.search.export(dto);
    return csvFile(name, body);
  }
}
