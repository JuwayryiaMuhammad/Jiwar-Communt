import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { SlaReportQueryDto } from './dto/sla.dto';
import { SlaReports } from './sla-report';
import { SlaReportView } from './views/sla.views';

/** Whether the SLA was kept (ADR 0076), for `tickets.dispatch`. */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/sla-report')
export class SlaReportController {
  constructor(private readonly reports: SlaReports) {}

  @Get()
  @ApiOperation({
    summary:
      'The SLA clocks met and breached over a period, by category, priority and clock',
  })
  @ApiOkResponse({ type: SlaReportView })
  async report(@Query() q: SlaReportQueryDto): Promise<SlaReportView> {
    return SlaReportView.from(await this.reports.report(q.from, q.to));
  }

  @Get('export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Export the SLA report of a period as CSV' })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: SlaReportQueryDto): Promise<StreamableFile> {
    return csvFile(
      `sla-${q.from}-${q.to}.csv`,
      await this.reports.csv(q.from, q.to),
    );
  }
}
