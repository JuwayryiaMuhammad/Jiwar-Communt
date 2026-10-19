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
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { BudgetsService } from './budgets.service';
import {
  BudgetLinesDto,
  BudgetSettingsDto,
  BudgetsQueryDto,
  DraftBudgetDto,
  ExpensesQueryDto,
  RecordExpenseDto,
} from './dto/budgets.dto';
import { ExpensesService } from './expenses.service';
import {
  BudgetSettingsView,
  BudgetView,
  ExpenseAuthorizationView,
  ExpenseView,
} from './views/budgets.views';

/** The annual budget (ADR 0055): the accountant's and the manager's. */
@ApiArea('finance')
@RequirePermissions('finance.budget')
@Controller('staff/finance')
export class BudgetsController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly expenses: ExpensesService,
  ) {}

  @Get('budget-settings')
  @NoStore()
  @ApiOperation({ summary: 'The month the fiscal year starts on' })
  @ApiOkResponse({ type: BudgetSettingsView })
  async settings(): Promise<BudgetSettingsView> {
    return { fiscalYearStartMonth: await this.budgets.startMonth() };
  }

  @Patch('budget-settings')
  @NoStore()
  @ApiOperation({
    summary: 'Set the month the fiscal year starts on',
    description: 'Until a budget exists (FISCAL_YEAR_LOCKED).',
  })
  @ApiOkResponse({ type: BudgetSettingsView })
  async setSettings(
    @Body() dto: BudgetSettingsDto,
  ): Promise<BudgetSettingsView> {
    return {
      fiscalYearStartMonth: await this.budgets.setStartMonth(
        dto.fiscalYearStartMonth,
      ),
    };
  }

  @Post('budgets')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Draft a fiscal year’s budget',
    description:
      'Optionally from another budget’s lines. Refused with an active budget for the year (BUDGET_YEAR_ACTIVE) or one in the making (BUDGET_IN_PROGRESS). It goes to the board as an annual_budget request (POST /staff/governance/approvals).',
  })
  @ApiCreatedResponse({ type: BudgetView })
  async draft(@Body() dto: DraftBudgetDto): Promise<BudgetView> {
    return BudgetView.from(await this.budgets.draft(dto));
  }

  @Get('budgets')
  @NoStore()
  @ApiOperation({ summary: 'List the budgets', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(BudgetView) })
  async list(@Query() q: BudgetsQueryDto): Promise<ListResponse<BudgetView>> {
    return toList(await this.budgets.list(q), (r) => BudgetView.from(r));
  }

  @Get('budgets/:id')
  @NoStore()
  @ApiOperation({
    summary: 'Read a budget',
    description:
      'Every line with what it allows, what was spent and what is left.',
  })
  @ApiOkResponse({ type: BudgetView })
  async get(@Param('id', parseId()) id: string): Promise<BudgetView> {
    return BudgetView.from(await this.budgets.get(id));
  }

  @Put('budgets/:id/lines')
  @NoStore()
  @ApiOperation({
    summary: 'Replace a draft’s lines',
    description:
      'One per category (DUPLICATE_VALUE); a draft only (BUDGET_NOT_DRAFT).',
  })
  @ApiOkResponse({ type: BudgetView })
  async lines(
    @Param('id', parseId()) id: string,
    @Body() dto: BudgetLinesDto,
  ): Promise<BudgetView> {
    return BudgetView.from(await this.budgets.replaceLines(id, dto.lines));
  }

  @Post('expenses')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Record an expense',
    description:
      'On a line of the active budget, within what it has left (EXPENSE_OVER_BUDGET); above the manager’s limit it names an approved major contract (EXPENSE_NEEDS_APPROVAL, EXPENSE_AUTHORIZATION_EXCEEDED).',
  })
  @ApiCreatedResponse({ type: ExpenseView })
  async record(@Body() dto: RecordExpenseDto): Promise<ExpenseView> {
    return ExpenseView.from(await this.expenses.record(dto));
  }

  @Get('expenses')
  @NoStore()
  @ApiOperation({ summary: 'List the expenses', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(ExpenseView) })
  async expensesList(
    @Query() q: ExpensesQueryDto,
  ): Promise<ListResponse<ExpenseView>> {
    return toList(await this.expenses.list(q), (r) => ExpenseView.from(r));
  }

  @Get('expenses/:id')
  @NoStore()
  @ApiOperation({ summary: 'Read an expense' })
  @ApiOkResponse({ type: ExpenseView })
  async expense(@Param('id', parseId()) id: string): Promise<ExpenseView> {
    return ExpenseView.from(await this.expenses.get(id));
  }

  @Post('expenses/:id/void')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Void an expense',
    description: 'Once, with an `expenseVoid` code: the line has it again.',
  })
  @ApiOkResponse({ type: ExpenseView })
  async void(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<ExpenseView> {
    return ExpenseView.from(await this.expenses.void(id, dto.reasonCode));
  }

  @Get('expense-authorizations')
  @NoStore()
  @ApiOperation({
    summary: 'The major contracts the board approved',
    description:
      'What expenses above the manager’s limit may name, with what is left.',
  })
  @ApiOkResponse({ type: [ExpenseAuthorizationView] })
  async authorizations(): Promise<ExpenseAuthorizationView[]> {
    return (await this.expenses.authorizations()).map((a) =>
      ExpenseAuthorizationView.from(a),
    );
  }
}
