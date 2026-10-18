import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { SecurityReportQueryDto } from './dto/security-reports.dto';
import { SecurityReportsService } from './security-reports.service';
import {
  IncidentReportView,
  ViolationReportView,
} from './views/security-reports.views';

const CSV =
  'UTF-8 with a byte-order mark, CRLF; one row per type, the totals last (`all`).';

/** The incidents report (ADR 0053). */
@ApiArea('incidents')
@RequireAnyPermission('incidents.manage', 'guard_reports.read')
@Controller('staff/security/reports/incidents')
export class IncidentReportController {
  constructor(private readonly reports: SecurityReportsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Read the incidents report',
    description:
      'Per type, the incidents that happened on the compound’s days asked: reported, by guards, by severity, open, investigating and closed now, and the average hours to a close. Counts only.',
  })
  @ApiOkResponse({ type: IncidentReportView })
  report(@Query() q: SecurityReportQueryDto): Promise<IncidentReportView> {
    return this.reports.incidents(q);
  }

  @Get('export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export the incidents report as CSV',
    description: CSV,
  })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: SecurityReportQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.reports.incidentsCsv(q);
    return csvFile(name, body);
  }
}

/** The violations report (ADR 0053). */
@ApiArea('violations')
@RequireAnyPermission('violations.manage', 'guard_reports.read')
@Controller('staff/security/reports/violations')
export class ViolationReportController {
  constructor(private readonly reports: SecurityReportsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Read the violations report',
    description:
      'Per kind, the violations of the compound’s days asked: issued, by guards, warnings and fined, the amounts issued and paid, open, under appeal, paid and cancelled now, and the appeals and their decisions. Counts only.',
  })
  @ApiOkResponse({ type: ViolationReportView })
  report(@Query() q: SecurityReportQueryDto): Promise<ViolationReportView> {
    return this.reports.violations(q);
  }

  @Get('export')
  @NoStore()
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export the violations report as CSV',
    description: CSV.replace('per type', 'per kind'),
  })
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: SecurityReportQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.reports.violationsCsv(q);
    return csvFile(name, body);
  }
}
