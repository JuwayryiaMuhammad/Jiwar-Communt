import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { TrafficReportQueryDto } from './dto/traffic-report.dto';
import { TrafficReportService } from './traffic-report.service';
import { TrafficReportView } from './views/traffic-report.views';

/** The gate's traffic (ADR 0056): the management's, `gate.read`. */
@ApiArea('gate')
@RequirePermissions('gate.read')
@Controller('staff/gate/reports')
export class TrafficReportController {
  constructor(private readonly reports: TrafficReportService) {}

  @Get('traffic')
  @NoStore()
  @ApiOperation({
    summary: 'Read the gate’s traffic',
    description:
      'Per compound day and gate: visitors by how they came in, service vehicles by kind, resident vehicles counted in and out. Counts only. The last seven days by default, 31 at most.',
  })
  @ApiOkResponse({ type: TrafficReportView })
  async traffic(@Query() q: TrafficReportQueryDto): Promise<TrafficReportView> {
    return TrafficReportView.from(await this.reports.report(q));
  }

  @Get('traffic/export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export the gate’s traffic as CSV',
    description:
      'One row per day and gate, the totals last; UTF-8 with a byte-order mark, CRLF; text cells guarded against formulas.',
  })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: TrafficReportQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.reports.csv(q);
    return csvFile(name, body);
  }
}
