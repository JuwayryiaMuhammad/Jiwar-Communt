import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { DailyReportService } from './daily-report.service';
import { DailyReportQueryDto } from './dto/daily-report.dto';
import { DailyReportView } from './views/daily-report.views';

/** The guards' daily report (ADR 0050): `guard_reports.read`. */
@ApiArea('guard-duty')
@RequirePermissions('guard_reports.read')
@Controller('staff/security/reports')
export class DailyReportController {
  constructor(private readonly reports: DailyReportService) {}

  @Get('daily')
  @NoStore()
  @ApiOperation({
    summary: 'Read the daily report',
    description:
      'Per gate and per zone, for one of the compound’s days: shifts, lateness and absence, tasks, emergencies, gate services, visitors, and the patrol runs planned then (ADR 0052).',
  })
  @ApiOkResponse({ type: DailyReportView })
  daily(@Query() q: DailyReportQueryDto): Promise<DailyReportView> {
    return this.reports.daily(q);
  }

  @Get('daily/export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export the daily report as CSV',
    description:
      'One row per post; UTF-8 with a byte-order mark, CRLF; text cells guarded against formulas. The patrols’ five counts are the last columns.',
  })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: DailyReportQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.reports.csv(q);
    return csvFile(name, body);
  }
}
