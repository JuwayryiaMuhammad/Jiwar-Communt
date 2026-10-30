import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { PublishSpendingReportDto } from './dto/spending-report.dto';
import {
  SpendingReportsService,
  type SpendingReport,
} from './spending-reports.service';
import { SpendingReportView } from './views/spending-report.views';

/** The finance staff's spending reports (ADR 0069). */
@ApiArea('finance')
@Controller('staff/finance/spending-reports')
export class StaffSpendingReportsController {
  constructor(private readonly reports: SpendingReportsService) {}

  @Get()
  @RequireAnyPermission('finance.reports', 'finance.budget')
  @ApiOperation({
    summary: 'List the published spending reports, newest first',
  })
  @ApiOkResponse({ type: ListOf(SpendingReportView) })
  async list(): Promise<ListResponse<SpendingReportView>> {
    return bounded(await this.reports.list(), (r) => r);
  }

  @Post()
  @RequirePermissions('finance.reports')
  @Idempotent()
  @ApiOperation({
    summary: 'Publish where the fees went: a budget as of today, by category',
    description:
      'One act: the figures are the budget’s as of the compound’s today, and the report never changes after. One a budget a day.',
  })
  @ApiCreatedResponse({ type: SpendingReportView })
  publish(@Body() dto: PublishSpendingReportDto): Promise<SpendingReport> {
    return this.reports.publish(dto);
  }
}

/**
 * Where the fees went, for everyone who sees a unit's money (ADR 0069):
 * tenants as well as owners.
 */
@ApiArea('finance')
@RequirePermissions('units.read')
@Controller('finance/spending-reports')
export class SpendingReportsController {
  constructor(private readonly reports: SpendingReportsService) {}

  @Get()
  @ApiOperation({ summary: 'List where the fees went, newest first' })
  @ApiOkResponse({ type: ListOf(SpendingReportView) })
  async list(): Promise<ListResponse<SpendingReportView>> {
    await this.reports.assertReader();
    return bounded(await this.reports.list(), (r) => r);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a spending report' })
  @ApiOkResponse({ type: SpendingReportView })
  async get(@Param('id', parseId()) id: string): Promise<SpendingReport> {
    await this.reports.assertReader();
    return this.reports.get(id);
  }
}
