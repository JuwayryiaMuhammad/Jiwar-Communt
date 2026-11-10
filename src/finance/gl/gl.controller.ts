import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { csvFile } from '../../core/common/csv';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { PeriodDto } from '../reports/dto/ledger.dto';
import { GlEntriesService } from './gl-entries.service';
import { GlLedgerService } from './gl-ledger.service';
import {
  GlAsOfQueryDto,
  GlCloseMonthDto,
  GlCloseYearDto,
  GlCreateAccountDto,
  GlEntriesQueryDto,
  GlLedgerQueryDto,
  GlManualEntriesQueryDto,
  GlManualEntryDto,
  GlRejectEntryDto,
  GlRenameAccountDto,
  GlReopenMonthDto,
  GlReopenYearDto,
  GlReverseEntryDto,
} from './gl.dto';
import {
  GlAccountBalanceView,
  GlAccountView,
  GlBalanceSheetView,
  GlChartView,
  GlEntryView,
  GlIncomeStatementView,
  GlLedgerLineView,
  GlManualEntryView,
  GlPeriodView,
  GlReconciliationView,
  GlTrialBalanceView,
  GlYearView,
} from './gl.views';
import { GlYearsService } from './gl-years.service';

/**
 * The general ledger (ADR 0092): double entry, beside ADR 0048's computed
 * journal (`/staff/finance/ledger`), which stays. Read with
 * `finance.ledger`; the chart, manual entries and closing months with
 * `finance.ledger_write`; reopening a month with `finance.ledger_reopen`
 * (the manager's). Every response no-store: the compound's books.
 */
@ApiArea('finance')
@Controller('staff/finance/gl')
export class GlController {
  constructor(
    private readonly ledger: GlLedgerService,
    private readonly entries: GlEntriesService,
    private readonly years_: GlYearsService,
  ) {}

  // --------------------------------------------------------------------------
  // The chart
  // --------------------------------------------------------------------------

  @Get('accounts')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The chart of accounts with their balances',
    description:
      'Every account, by code, with its own debits and credits up to `asOf` and its balance with its sub-accounts’ on its normal side. A compound starts with the standard chart; each bank and cash account of the treasury has its own.',
  })
  @ApiOkResponse({ type: GlChartView })
  async chart(@Query() q: GlAsOfQueryDto): Promise<GlChartView> {
    return GlChartView.from(await this.ledger.chart(q.asOf));
  }

  @Post('accounts')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Add a sub-account',
    description:
      'Under any account but a control one (GL_ACCOUNT_CONTROLLED), of its type; its code its parent’s with a dot and up to three digits, once in the chart (DUPLICATE_RESOURCE).',
  })
  @ApiCreatedResponse({ type: GlAccountView })
  async create(@Body() dto: GlCreateAccountDto): Promise<GlAccountView> {
    return GlAccountView.from(await this.ledger.createAccount(dto));
  }

  @Get('accounts/:id')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'An account and its balance on a day' })
  @ApiOkResponse({ type: GlAccountBalanceView })
  async account(
    @Param('id', parseId()) id: string,
    @Query() q: GlAsOfQueryDto,
  ): Promise<GlAccountBalanceView> {
    return GlAccountBalanceView.from(await this.ledger.account(id, q.asOf));
  }

  @Patch('accounts/:id')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Rename an account',
    description: 'Its names only: a code, a type and a place never change.',
  })
  @ApiOkResponse({ type: GlAccountView })
  async rename(
    @Param('id', parseId()) id: string,
    @Body() dto: GlRenameAccountDto,
  ): Promise<GlAccountView> {
    return GlAccountView.from(await this.ledger.renameAccount(id, dto));
  }

  @Delete('accounts/:id')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a sub-account nothing posted to',
    description:
      'A system account never (GL_ACCOUNT_SYSTEM); one with lines or sub-accounts never (GL_ACCOUNT_IN_USE).',
  })
  @ApiNoContentResponse()
  async remove(@Param('id', parseId()) id: string): Promise<void> {
    await this.ledger.deleteAccount(id);
  }

  @Get('accounts/:id/ledger')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'An account’s ledger',
    description:
      'Its own lines of a period (at most 366 days), oldest first, each with the account’s balance after it on its normal side.',
  })
  @ApiOkResponse({ type: ListOf(GlLedgerLineView) })
  async accountLedger(
    @Param('id', parseId()) id: string,
    @Query() q: GlLedgerQueryDto,
  ): Promise<ListResponse<GlLedgerLineView>> {
    return toList(await this.ledger.ledger(id, q), (x) =>
      GlLedgerLineView.from(x),
    );
  }

  @Get('accounts/:id/ledger/export')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'Export an account’s ledger as CSV' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async accountLedgerCsv(
    @Param('id', parseId()) id: string,
    @Query() q: PeriodDto,
  ): Promise<StreamableFile> {
    const { name, body } = await this.ledger.ledgerCsv(id, q);
    return csvFile(name, body);
  }

  // --------------------------------------------------------------------------
  // The statements
  // --------------------------------------------------------------------------

  @Get('trial-balance')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The trial balance on a day',
    description:
      'Every account with lines up to `asOf`, its balance as a debit or a credit; the two totals agree.',
  })
  @ApiOkResponse({ type: GlTrialBalanceView })
  async trialBalance(@Query() q: GlAsOfQueryDto): Promise<GlTrialBalanceView> {
    return GlTrialBalanceView.from(await this.ledger.trialBalance(q.asOf));
  }

  @Get('income-statement')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The income statement of a period',
    description:
      'Revenue and expense accounts with lines on the period’s days (at most 366), and the surplus.',
  })
  @ApiOkResponse({ type: GlIncomeStatementView })
  async incomeStatement(@Query() q: PeriodDto): Promise<GlIncomeStatementView> {
    return GlIncomeStatementView.from(await this.ledger.incomeStatement(q));
  }

  @Get('balance-sheet')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The balance sheet on a day',
    description:
      'Assets, liabilities and equity up to `asOf`, with the surplus no entry closed into equity.',
  })
  @ApiOkResponse({ type: GlBalanceSheetView })
  async balanceSheet(@Query() q: GlAsOfQueryDto): Promise<GlBalanceSheetView> {
    return GlBalanceSheetView.from(await this.ledger.balanceSheet(q.asOf));
  }

  @Get('reconciliation')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The ledger against its registers',
    description:
      'Each bank and cash account against its movements (ADR 0085); receivables against what the units owe and unit credit against their free money (ADR 0046, 0048); deposits held (ADR 0062); payables, retentions and vendor advances (ADR 0089). A difference of zero is agreement.',
  })
  @ApiOkResponse({ type: GlReconciliationView })
  async reconciliation(): Promise<GlReconciliationView> {
    return GlReconciliationView.from(await this.ledger.reconciliation());
  }

  // --------------------------------------------------------------------------
  // The journal
  // --------------------------------------------------------------------------

  @Get('entries')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The journal of a period',
    description:
      'Every entry on the period’s days (at most 366), in the journal’s order, with its lines; by source.',
  })
  @ApiOkResponse({ type: ListOf(GlEntryView) })
  async journal(
    @Query() q: GlEntriesQueryDto,
  ): Promise<ListResponse<GlEntryView>> {
    return toList(await this.ledger.entries(q), (x) => GlEntryView.from(x));
  }

  @Get('entries/:id')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'An entry and its lines' })
  @ApiOkResponse({ type: GlEntryView })
  async entry(@Param('id', parseId()) id: string): Promise<GlEntryView> {
    return GlEntryView.from(await this.ledger.entry(id));
  }

  @Post('entries/:id/reverse')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Reverse a manual entry',
    description:
      'Writes a manual entry of its lines the other way round, for a second person’s approval. An automatic entry is corrected at its source (GL_ENTRY_NOT_REVERSIBLE); an entry is reversed once (GL_ENTRY_REVERSED).',
  })
  @ApiCreatedResponse({ type: GlManualEntryView })
  async reverse(
    @Param('id', parseId()) id: string,
    @Body() dto: GlReverseEntryDto,
  ): Promise<GlManualEntryView> {
    return GlManualEntryView.from(await this.entries.reverse(id, dto));
  }

  @Get('journal/export')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'Export the journal of a period as CSV',
    description:
      'One row a line, for an outside accounting system: the entry, its days, its source and reference, the account by code and name, the debit or credit, the unit and the vendor it names, and a manual entry’s words.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async journalCsv(@Query() q: PeriodDto): Promise<StreamableFile> {
    const { name, body } = await this.ledger.journalCsv(q);
    return csvFile(name, body);
  }

  // --------------------------------------------------------------------------
  // Manual entries
  // --------------------------------------------------------------------------

  @Get('manual-entries')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'Manual journal entries, newest first' })
  @ApiOkResponse({ type: ListOf(GlManualEntryView) })
  async manualEntries(
    @Query() q: GlManualEntriesQueryDto,
  ): Promise<ListResponse<GlManualEntryView>> {
    return toList(await this.entries.list(q), (x) => GlManualEntryView.from(x));
  }

  @Post('manual-entries')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Write a manual journal entry',
    description:
      'Pending until another `finance.ledger_write` holder approves it. Balanced (GL_ENTRY_UNBALANCED), on postable accounts no register keeps (GL_ACCOUNT_CONTROLLED, GL_ACCOUNT_NOT_POSTABLE), dated in an open month (GL_PERIOD_CLOSED).',
  })
  @ApiCreatedResponse({ type: GlManualEntryView })
  async submit(@Body() dto: GlManualEntryDto): Promise<GlManualEntryView> {
    return GlManualEntryView.from(await this.entries.submit(dto));
  }

  @Get('manual-entries/:id')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({ summary: 'A manual journal entry' })
  @ApiOkResponse({ type: GlManualEntryView })
  async manualEntry(
    @Param('id', parseId()) id: string,
  ): Promise<GlManualEntryView> {
    return GlManualEntryView.from(await this.entries.read(id));
  }

  @Post('manual-entries/:id/approve')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Approve and post a manual entry',
    description:
      'By someone other than its maker (GL_SELF_APPROVAL), while its month is open (GL_PERIOD_CLOSED).',
  })
  @ApiCreatedResponse({ type: GlManualEntryView })
  async approve(
    @Param('id', parseId()) id: string,
  ): Promise<GlManualEntryView> {
    return GlManualEntryView.from(await this.entries.approve(id));
  }

  @Post('manual-entries/:id/reject')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Turn a manual entry down',
    description: 'With a `glEntryReject` reason; never its maker.',
  })
  @ApiCreatedResponse({ type: GlManualEntryView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: GlRejectEntryDto,
  ): Promise<GlManualEntryView> {
    return GlManualEntryView.from(
      await this.entries.reject(id, dto.reasonCode),
    );
  }

  @Post('manual-entries/:id/withdraw')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({ summary: 'Withdraw one’s own pending entry' })
  @ApiCreatedResponse({ type: GlManualEntryView })
  async withdraw(
    @Param('id', parseId()) id: string,
  ): Promise<GlManualEntryView> {
    return GlManualEntryView.from(await this.entries.withdraw(id));
  }

  // --------------------------------------------------------------------------
  // The months
  // --------------------------------------------------------------------------

  @Get('periods')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The ledger’s months, newest first',
    description: 'From the first entry’s month to this one: open or closed.',
  })
  @ApiOkResponse({ type: ListOf(GlPeriodView) })
  async periods(): Promise<ListResponse<GlPeriodView>> {
    return bounded(await this.entries.periods(), (x) => GlPeriodView.from(x));
  }

  @Post('periods/close')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Close the months through one',
    description:
      'A month that has ended (GL_PERIOD_NOT_ENDED), and every open month before it from the ledger’s first. No entry is then dated in them; an event of a closed month posts on the first day of the next open one.',
  })
  @ApiCreatedResponse({ type: ListOf(GlPeriodView) })
  async close(
    @Body() dto: GlCloseMonthDto,
  ): Promise<ListResponse<GlPeriodView>> {
    return bounded(await this.entries.close(dto.month), (x) =>
      GlPeriodView.from(x),
    );
  }

  @Post('periods/reopen')
  @NoStore()
  @RequirePermissions('finance.ledger_reopen')
  @ApiOperation({
    summary: 'Reopen a closed month',
    description:
      'The manager’s alone, with a `glPeriodReopen` reason; audited.',
  })
  @ApiCreatedResponse({ type: ListOf(GlPeriodView) })
  async reopen(
    @Body() dto: GlReopenMonthDto,
  ): Promise<ListResponse<GlPeriodView>> {
    return bounded(await this.entries.reopen(dto.month, dto.reasonCode), (x) =>
      GlPeriodView.from(x),
    );
  }

  // --------------------------------------------------------------------------
  // The fiscal years (ADR 0093)
  // --------------------------------------------------------------------------

  @Get('years')
  @NoStore()
  @RequirePermissions('finance.ledger')
  @ApiOperation({
    summary: 'The fiscal years, newest first',
    description:
      'From the first entry’s year to this one, on the compound’s start month (ADR 0055): open or closed, whether it may be closed now, and its months still open.',
  })
  @ApiOkResponse({ type: ListOf(GlYearView) })
  async years(): Promise<ListResponse<GlYearView>> {
    return bounded(await this.years_.years(), (x) => GlYearView.from(x));
  }

  @Post('years/close')
  @NoStore()
  @RequirePermissions('finance.ledger_write')
  @ApiOperation({
    summary: 'Close a fiscal year',
    description:
      'Once every month of it is closed (GL_YEAR_MONTHS_OPEN {months}) and every earlier year with entries is (GL_YEAR_PREVIOUS_OPEN {startsOn}): one closing entry, dated its last day, zeroes each revenue and expense account into accumulated surplus, and the year is locked (GL_YEAR_CLOSED). Audited.',
  })
  @ApiCreatedResponse({ type: ListOf(GlYearView) })
  async closeYear(
    @Body() dto: GlCloseYearDto,
  ): Promise<ListResponse<GlYearView>> {
    return bounded(await this.years_.close(dto.startsOn), (x) =>
      GlYearView.from(x),
    );
  }

  @Post('years/reopen')
  @NoStore()
  @RequirePermissions('finance.ledger_reopen')
  @ApiOperation({
    summary: 'Reopen a closed fiscal year',
    description:
      'The manager’s alone, with a `glPeriodReopen` reason, the latest closed year first (GL_YEAR_LATER_CLOSED): its closing entry is reversed on the same day. Its months stay closed until one is reopened. Audited.',
  })
  @ApiCreatedResponse({ type: ListOf(GlYearView) })
  async reopenYear(
    @Body() dto: GlReopenYearDto,
  ): Promise<ListResponse<GlYearView>> {
    return bounded(
      await this.years_.reopen(dto.startsOn, dto.reasonCode),
      (x) => GlYearView.from(x),
    );
  }
}
