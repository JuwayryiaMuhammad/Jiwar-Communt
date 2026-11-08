import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  type StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BudgetsService } from '../budgets/budgets.service';
import { BudgetView } from '../budgets/views/budgets.views';
import { BudgetPlanningService } from './budget-planning.service';
import { CommitmentsService } from './commitments.service';
import {
  BudgetPhasingDto,
  BudgetTransferDto,
  CommitmentsQueryDto,
  FinanceEntriesQueryDto,
  PeriodsQueryDto,
  TransfersQueryDto,
  VarianceReasonDto,
  VarianceSettingDto,
} from './dto/payables.dto';
import { PayablesReportsService } from './payables-reports.service';
import {
  BudgetTransferView,
  CommitmentView,
  PeriodReportView,
  VarianceSettingView,
} from './views/payables.views';

/**
 * Budget planning (ADR 0089): transfers between two lines, a line's months,
 * why a line ran past its plan, and the commitments that keep budget.
 * `finance.budget`, as the budget is.
 */
@ApiArea('finance')
@RequirePermissions('finance.budget')
@Controller('staff/finance')
export class BudgetPlanningController {
  constructor(
    private readonly planning: BudgetPlanningService,
    private readonly budgets: BudgetsService,
    private readonly commitments: CommitmentsService,
    private readonly ctx: RequestContext,
  ) {}

  @Post('budget-transfers')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Move budget between two lines',
    description:
      'Two lines of the active budget, at most what the line it leaves has available (BUDGET_LINE_INSUFFICIENT). Within the manager’s limit it is applied at once; above it, it waits for the board (`awaiting_board`): raise a `budget_transfer` request naming it (POST /staff/governance/approvals).',
  })
  @ApiCreatedResponse({ type: BudgetTransferView })
  async transfer(@Body() dto: BudgetTransferDto): Promise<BudgetTransferView> {
    return BudgetTransferView.from(
      await this.planning.transfer(dto),
      this.ctx.accountId,
    );
  }

  @Get('budget-transfers')
  @NoStore()
  @ApiOperation({
    summary: 'List a budget’s transfers',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: [BudgetTransferView] })
  async transfers(
    @Query() q: TransfersQueryDto,
  ): Promise<BudgetTransferView[]> {
    return (await this.planning.listTransfers(q.budgetId)).map((t) =>
      BudgetTransferView.from(t, this.ctx.accountId),
    );
  }

  @Get('budget-transfers/:id')
  @NoStore()
  @ApiOperation({ summary: 'Read a budget transfer' })
  @ApiOkResponse({ type: BudgetTransferView })
  async getTransfer(
    @Param('id', parseId()) id: string,
  ): Promise<BudgetTransferView> {
    return BudgetTransferView.from(
      await this.planning.getTransfer(id),
      this.ctx.accountId,
    );
  }

  @Post('budget-transfers/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Call off a transfer waiting for the board',
    description:
      'Before it is raised; once raised, governance withdraws the request (BUDGET_TRANSFER_STATE).',
  })
  @ApiOkResponse({ type: BudgetTransferView })
  async cancelTransfer(
    @Param('id', parseId()) id: string,
  ): Promise<BudgetTransferView> {
    return BudgetTransferView.from(
      await this.planning.cancelTransfer(id),
      this.ctx.accountId,
    );
  }

  @Put('budgets/:id/months')
  @NoStore()
  @ApiOperation({
    summary: 'Split the active budget’s lines by month',
    description:
      'Twelve months, or four quarters (a third on each month), adding up to the line’s amount (INVALID_VALUE with the count and total); `months: null` splits a line evenly again. Active budgets only (BUDGET_NOT_ACTIVE).',
  })
  @ApiOkResponse({ type: BudgetView })
  async phase(
    @Param('id', parseId()) id: string,
    @Body() dto: BudgetPhasingDto,
  ): Promise<BudgetView> {
    await this.planning.phase(id, dto.lines);
    return BudgetView.from(await this.budgets.get(id));
  }

  @Post('budget-lines/:id/variance-reasons')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoStore()
  @ApiOperation({
    summary: 'Say why a line ran past its plan in a month',
    description:
      'A `budgetVariance` code and a note; the latest of a month shows.',
  })
  @ApiNoContentResponse()
  async explain(
    @Param('id', parseId()) id: string,
    @Body() dto: VarianceReasonDto,
  ): Promise<void> {
    await this.planning.explain(id, dto);
  }

  @Get('variance-settings')
  @NoStore()
  @ApiOperation({
    summary: 'Past what share of its plan a month asks for a reason',
  })
  @ApiOkResponse({ type: VarianceSettingView })
  async varianceSetting(): Promise<VarianceSettingView> {
    return { varianceReasonPct: await this.planning.variancePct() };
  }

  @Patch('variance-settings')
  @NoStore()
  @ApiOperation({
    summary: 'Set past what share of its plan a month asks for a reason',
  })
  @ApiOkResponse({ type: VarianceSettingView })
  async setVarianceSetting(
    @Body() dto: VarianceSettingDto,
  ): Promise<VarianceSettingView> {
    return {
      varianceReasonPct: await this.planning.setVariancePct(
        dto.varianceReasonPct,
      ),
    };
  }

  @Get('commitments')
  @NoStore()
  @ApiOperation({
    summary: 'List the commitments',
    description:
      'Budget kept for a contract’s unpaid payment or an approved purchase, with what each still keeps; newest first.',
  })
  @ApiOkResponse({ type: ListOf(CommitmentView) })
  async list(
    @Query() q: CommitmentsQueryDto,
  ): Promise<ListResponse<CommitmentView>> {
    return toList(await this.commitments.list(q), (r) =>
      CommitmentView.from(r),
    );
  }
}

/** The period report and the entries export (ADR 0089): finance.reports. */
@ApiArea('finance')
@RequirePermissions('finance.reports')
@Controller('staff/finance/reports')
export class PayablesReportsController {
  constructor(
    private readonly planning: BudgetPlanningService,
    private readonly reports: PayablesReportsService,
  ) {}

  @Get('budget-periods')
  @NoStore()
  @ApiOperation({
    summary: 'Read the budget by month or quarter',
    description:
      'Per line and period: planned, actual, the variance, and whether a closed period past the compound’s setting has no reason yet. By default the active budget of the year under way.',
  })
  @ApiOkResponse({ type: PeriodReportView })
  periods(@Query() q: PeriodsQueryDto): Promise<PeriodReportView> {
    return this.planning.periods(q);
  }

  @Get('budget-periods/export')
  @NoStore()
  @ApiOperation({ summary: 'Export the budget by month or quarter as CSV' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async periodsCsv(@Query() q: PeriodsQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.planning.periodsCsv(q);
    return csvFile(name, body);
  }

  @Get('entries/export')
  @NoStore()
  @ApiOperation({
    summary: 'Export every money entry of a period as CSV',
    description:
      'For a ledger to come (ADR 0089): each expense and its void, each vendor invoice approved or called off after it, each payout, commitment and release, each applied transfer and approved increase, once, by the compound’s day; at most 366 days (EXPORT_TOO_LARGE past the row limit).',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async entries(@Query() q: FinanceEntriesQueryDto): Promise<StreamableFile> {
    const { name, body } = await this.reports.entriesCsv(q);
    return csvFile(name, body);
  }
}
