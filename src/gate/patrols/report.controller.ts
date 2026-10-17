import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { PatrolReportQueryDto } from './dto/report.dto';
import { PatrolReportService } from './patrol-report.service';
import { PatrolReportView } from './views/report.views';

/** The patrol report (ADR 0052). */
@ApiArea('patrols')
@Controller('staff/security/patrols/report')
export class PatrolReportController {
  constructor(private readonly reports: PatrolReportService) {}

  @Get()
  @NoStore()
  @RequireAnyPermission('patrols.manage', 'guard_reports.read')
  @ApiOperation({
    summary: 'Read the patrol report',
    description:
      'Per route, the runs planned on the compound’s days asked: scheduled, unscheduled, done, late, missed, incomplete, cancelled; scans by hand, flagged and received late; the average length of a completed run.',
  })
  @ApiOkResponse({ type: PatrolReportView })
  report(@Query() q: PatrolReportQueryDto): Promise<PatrolReportView> {
    return this.reports.build(q);
  }
}
