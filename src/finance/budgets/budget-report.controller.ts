import { Controller, Get, Query, type StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { BudgetReportService } from './budget-report.service';
import { BudgetVsActualQueryDto } from './dto/budget-report.dto';
import { BudgetVsActualView } from './views/budget-report.views';

/** Budget vs actual (ADR 0055), with its CSV twin: finance.reports. */
@ApiArea('finance')
@RequirePermissions('finance.reports')
@Controller('staff/finance/reports')
export class BudgetReportController {
  constructor(private readonly report: BudgetReportService) {}

  @Get('budget-vs-actual')
  @NoStore()
  @ApiOperation({
    summary: 'Read budget vs actual',
    description:
      'Per line: budgeted, approved increases, the allowance, live expenses and what is left, with the totals. By default the active budget of the fiscal year under way (BUDGET_NOT_FOUND without one).',
  })
  @ApiOkResponse({ type: BudgetVsActualView })
  get(@Query() q: BudgetVsActualQueryDto): Promise<BudgetVsActualView> {
    return this.report.report(q);
  }

  @Get('budget-vs-actual/export')
  @NoStore()
  @ApiOperation({
    summary: 'Export budget vs actual as CSV',
    description: 'The same rows, the totals last (`all`).',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(@Query() q: BudgetVsActualQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.report.csv(q);
    return csvFile(name, body);
  }
}
