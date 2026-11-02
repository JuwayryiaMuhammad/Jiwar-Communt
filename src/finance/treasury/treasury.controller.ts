import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { CashAccountsService } from './cash-accounts.service';
import { ChequesService } from './cheques.service';
import { CustodyService } from './custody.service';
import {
  CashAccountsQueryDto,
  CashAdjustmentDto,
  CashMovementsQueryDto,
  CashTransferDto,
  ChequeReasonDto,
  ChequesQueryDto,
  CreateCashAccountDto,
  CustodyHandinDto,
  CustodyOutcomeDto,
  DepositChequeDto,
  HandinsQueryDto,
  InvestigationsQueryDto,
  MatchLineDto,
  OpenInvestigationDto,
  ReceiveChequeDto,
  StatementImportDto,
  StatementImportsQueryDto,
  StatementLinesQueryDto,
  UpdateCashAccountDto,
} from './dto/treasury.dto';
import { StatementsService } from './statements.service';
import {
  CashAccountView,
  CashMovementView,
  CashTransferView,
  ChequeView,
  CustodyHandinDetailView,
  CustodyHandinView,
  CustodyInvestigationView,
  CustodySummaryView,
  CustodyView,
  MatchCandidateView,
  StatementImportView,
  StatementLineView,
} from './views/treasury.views';

/** The compound's bank and cash accounts and their statements (ADR 0085). */
@ApiArea('finance')
@RequirePermissions('finance.treasury')
@Controller('staff/finance')
export class TreasuryController {
  constructor(
    private readonly accounts: CashAccountsService,
    private readonly statements: StatementsService,
  ) {}

  @Get('cash-accounts')
  @ApiOperation({
    summary: 'List the bank and cash accounts with their balances',
  })
  @ApiOkResponse({ type: ListOf(CashAccountView) })
  async list(
    @Query() q: CashAccountsQueryDto,
  ): Promise<ListResponse<CashAccountView>> {
    return bounded(
      await this.accounts.list(q.includeRetired === 'true'),
      (v) => v,
    );
  }

  @Post('cash-accounts')
  @ApiOperation({
    summary: 'Open a bank account or a cash box, with its opening balance',
  })
  @ApiCreatedResponse({ type: CashAccountView })
  create(@Body() dto: CreateCashAccountDto): Promise<CashAccountView> {
    return this.accounts.create(dto);
  }

  @Get('cash-accounts/:id')
  @ApiOperation({ summary: 'Get an account and its balance' })
  @ApiOkResponse({ type: CashAccountView })
  get(@Param('id', parseId()) id: string): Promise<CashAccountView> {
    return this.accounts.get(id);
  }

  @Patch('cash-accounts/:id')
  @ApiOperation({
    summary: 'Rename an account; a bank account’s bank and last four digits',
  })
  @ApiOkResponse({ type: CashAccountView })
  update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateCashAccountDto,
  ): Promise<CashAccountView> {
    return this.accounts.update(id, dto);
  }

  @Post('cash-accounts/:id/retire')
  @ApiOperation({ summary: 'Retire an account at a zero balance, once' })
  @ApiCreatedResponse({ type: CashAccountView })
  retire(@Param('id', parseId()) id: string): Promise<CashAccountView> {
    return this.accounts.retire(id);
  }

  @Post('cash-accounts/:id/adjustments')
  @Idempotent()
  @ApiOperation({
    summary: 'Adjust an account’s balance by hand, with a reason code',
    description: 'Positive in, negative out; a cash box never below zero.',
  })
  @ApiCreatedResponse({ type: CashMovementView })
  adjust(
    @Param('id', parseId()) id: string,
    @Body() dto: CashAdjustmentDto,
  ): Promise<CashMovementView> {
    return this.accounts.adjust(id, dto);
  }

  @Get('cash-movements')
  @ApiOperation({ summary: 'List movements, newest first' })
  @ApiOkResponse({ type: ListOf(CashMovementView) })
  async movements(
    @Query() q: CashMovementsQueryDto,
  ): Promise<ListResponse<CashMovementView>> {
    return toList(await this.accounts.movements(q), (v) => v);
  }

  @Post('cash-transfers')
  @Idempotent()
  @ApiOperation({
    summary: 'Move money between two of the compound’s accounts',
  })
  @ApiCreatedResponse({ type: CashTransferView })
  transfer(@Body() dto: CashTransferDto): Promise<CashTransferView> {
    return this.accounts.transfer(dto);
  }

  @Post('cash-accounts/:id/statement-imports')
  @Idempotent()
  @ApiOperation({
    summary: 'Check a bank statement’s CSV: a dry run',
    description:
      'Columns date, amount (money in positive), reference and description. Says how many lines are new and how many were imported before; imports nothing.',
  })
  @ApiCreatedResponse({ type: StatementImportView })
  check(
    @Param('id', parseId()) id: string,
    @Body() dto: StatementImportDto,
  ): Promise<StatementImportView> {
    return this.statements.check(id, dto.fileId);
  }

  @Get('statement-imports')
  @ApiOperation({ summary: 'List statement imports, newest first' })
  @ApiOkResponse({ type: ListOf(StatementImportView) })
  async imports(
    @Query() q: StatementImportsQueryDto,
  ): Promise<ListResponse<StatementImportView>> {
    return toList(await this.statements.imports(q), (v) => v);
  }

  @Get('statement-imports/:id')
  @ApiOperation({ summary: 'Get a statement import' })
  @ApiOkResponse({ type: StatementImportView })
  getImport(@Param('id', parseId()) id: string): Promise<StatementImportView> {
    return this.statements.getImport(id);
  }

  @Post('statement-imports/:id/apply')
  @ApiOperation({
    summary: 'Apply a checked statement, once, within a day',
    description:
      'Imports its new lines and matches on their own those that name exactly one payment, cheque or transfer.',
  })
  @ApiCreatedResponse({ type: StatementImportView })
  apply(@Param('id', parseId()) id: string): Promise<StatementImportView> {
    return this.statements.apply(id);
  }

  @Get('statement-lines')
  @ApiOperation({
    summary: 'List statement lines, newest first, with their matches',
  })
  @ApiOkResponse({ type: ListOf(StatementLineView) })
  async lines(
    @Query() q: StatementLinesQueryDto,
  ): Promise<ListResponse<StatementLineView>> {
    return toList(await this.statements.lines(q), (v) => v);
  }

  @Get('statement-lines/:id/candidates')
  @ApiOperation({
    summary: 'What a line could be matched to: the same amount within 30 days',
  })
  @ApiOkResponse({ type: ListOf(MatchCandidateView) })
  async candidates(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<MatchCandidateView>> {
    return bounded(await this.statements.candidatesOf(id), (v) => v);
  }

  @Post('statement-lines/:id/match')
  @ApiOperation({
    summary: 'Match a line to a payment, a cheque, a transfer or an adjustment',
  })
  @ApiCreatedResponse({ type: StatementLineView })
  match(
    @Param('id', parseId()) id: string,
    @Body() dto: MatchLineDto,
  ): Promise<StatementLineView> {
    return this.statements.match(id, dto);
  }

  @Post('statement-matches/:id/undo')
  @ApiOperation({ summary: 'Undo a match, once; what it moved is reversed' })
  @ApiCreatedResponse({ type: StatementLineView })
  undo(@Param('id', parseId()) id: string): Promise<StatementLineView> {
    return this.statements.undo(id);
  }
}

/** Collectors' and cashiers' custody (ADR 0085, C1). */
@ApiArea('finance')
@Controller('staff/finance')
export class CustodyController {
  constructor(private readonly custody: CustodyService) {}

  @Get('custody')
  @RequirePermissions('finance.payments')
  @ApiOperation({
    summary: 'Everyone’s cash not handed in, and unsettled variances',
  })
  @ApiOkResponse({ type: ListOf(CustodySummaryView) })
  async summary(): Promise<ListResponse<CustodySummaryView>> {
    return bounded(await this.custody.summary(), (v) => v);
  }

  @Get('custody/:accountId')
  @RequirePermissions('finance.payments')
  @ApiOperation({
    summary: 'One custodian’s open payments and latest hand-ins',
  })
  @ApiOkResponse({ type: CustodyView })
  get(
    @Param('accountId', parseId('accountId')) accountId: string,
  ): Promise<CustodyView> {
    return this.custody.custody(accountId);
  }

  @Post('custody/:accountId/handins')
  @RequirePermissions('finance.payments')
  @Idempotent()
  @ApiOperation({
    summary: 'Record a custodian’s cash handed in',
    description:
      'Every open payment at once, into a cash box, against the expected amount shown (409 CUSTODY_CHANGED otherwise). A count that differs needs its reason and stays open until settled.',
  })
  @ApiCreatedResponse({ type: CustodyHandinDetailView })
  handIn(
    @Param('accountId', parseId('accountId')) accountId: string,
    @Body() dto: CustodyHandinDto,
  ): Promise<CustodyHandinDetailView> {
    return this.custody.handIn(accountId, dto);
  }

  @Get('custody-handins')
  @RequirePermissions('finance.payments')
  @ApiOperation({ summary: 'List hand-ins, newest first' })
  @ApiOkResponse({ type: ListOf(CustodyHandinView) })
  async handins(
    @Query() q: HandinsQueryDto,
  ): Promise<ListResponse<CustodyHandinView>> {
    return toList(await this.custody.handins(q), (v) => v);
  }

  @Get('custody-handins/:id')
  @RequirePermissions('finance.payments')
  @ApiOperation({
    summary: 'Get a hand-in, its payments and its investigation',
  })
  @ApiOkResponse({ type: CustodyHandinDetailView })
  handin(@Param('id', parseId()) id: string): Promise<CustodyHandinDetailView> {
    return this.custody.handin(id);
  }

  @Post('custody-handins/:id/resolve')
  @RequirePermissions('finance.custody')
  @ApiOperation({
    summary: 'Settle a hand-in’s variance without an investigation',
  })
  @ApiCreatedResponse({ type: CustodyHandinDetailView })
  resolve(
    @Param('id', parseId()) id: string,
    @Body() dto: CustodyOutcomeDto,
  ): Promise<CustodyHandinDetailView> {
    return this.custody.resolve(id, dto);
  }

  @Post('custody-handins/:id/investigation')
  @RequirePermissions('finance.custody')
  @ApiOperation({ summary: 'Open an investigation of a hand-in’s variance' })
  @ApiCreatedResponse({ type: CustodyHandinDetailView })
  investigate(
    @Param('id', parseId()) id: string,
    @Body() dto: OpenInvestigationDto,
  ): Promise<CustodyHandinDetailView> {
    return this.custody.investigate(id, dto);
  }

  @Get('custody-investigations')
  @RequireAnyPermission('finance.custody', 'finance.payments')
  @ApiOperation({
    summary: 'List investigations, newest first',
    description:
      'Every one to finance.custody; to anyone else, those they own.',
  })
  @ApiOkResponse({ type: ListOf(CustodyInvestigationView) })
  async investigations(
    @Query() q: InvestigationsQueryDto,
  ): Promise<ListResponse<CustodyInvestigationView>> {
    return toList(await this.custody.investigations(q), (v) => v);
  }

  @Post('custody-investigations/:id/decide')
  @RequireAnyPermission('finance.custody', 'finance.payments')
  @ApiOperation({
    summary: 'Decide an investigation: its owner, or finance.custody',
  })
  @ApiCreatedResponse({ type: CustodyInvestigationView })
  decide(
    @Param('id', parseId()) id: string,
    @Body() dto: CustodyOutcomeDto,
  ): Promise<CustodyInvestigationView> {
    return this.custody.decide(id, dto);
  }
}

/** A collector's own custody (`finance.collect`). */
@ApiArea('finance')
@RequirePermissions('finance.collect')
@Controller('collector')
export class CollectorCustodyController {
  constructor(private readonly custody: CustodyService) {}

  @Get('custody')
  @ApiOperation({ summary: 'My cash not handed in, and my latest hand-ins' })
  @ApiOkResponse({ type: CustodyView })
  mine(): Promise<CustodyView> {
    return this.custody.mine();
  }
}

/** The cheque register (ADR 0085), for who keeps payments. */
@ApiArea('finance')
@RequirePermissions('finance.payments')
@Controller('staff')
export class ChequesController {
  constructor(private readonly cheques: ChequesService) {}

  @Post('units/:unitId/cheques')
  @Idempotent()
  @ApiOperation({
    summary: 'Record a cheque received for a unit',
    description:
      'Dated today or earlier, it pays at once as an office payment by cheque; post-dated, it is held and pays when deposited.',
  })
  @ApiCreatedResponse({ type: ChequeView })
  receive(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: ReceiveChequeDto,
  ): Promise<ChequeView> {
    return this.cheques.receive(unitId, dto);
  }

  @Get('finance/cheques')
  @ApiOperation({ summary: 'List the cheque register, newest first' })
  @ApiOkResponse({ type: ListOf(ChequeView) })
  async list(@Query() q: ChequesQueryDto): Promise<ListResponse<ChequeView>> {
    return toList(await this.cheques.list(q), (v) => v);
  }

  @Post('finance/cheques/:id/deposit')
  @ApiOperation({
    summary: 'Deposit a cheque into a bank account, from its due day',
  })
  @ApiCreatedResponse({ type: ChequeView })
  deposit(
    @Param('id', parseId()) id: string,
    @Body() dto: DepositChequeDto,
  ): Promise<ChequeView> {
    return this.cheques.deposit(id, dto.accountId);
  }

  @Post('finance/cheques/:id/clear')
  @ApiOperation({
    summary: 'A deposited cheque cleared: its money in the bank account',
  })
  @ApiCreatedResponse({ type: ChequeView })
  clear(@Param('id', parseId()) id: string): Promise<ChequeView> {
    return this.cheques.clear(id);
  }

  @Post('finance/cheques/:id/bounce')
  @ApiOperation({ summary: 'A deposited cheque bounced: its payment reversed' })
  @ApiCreatedResponse({ type: ChequeView })
  bounce(
    @Param('id', parseId()) id: string,
    @Body() dto: ChequeReasonDto,
  ): Promise<ChequeView> {
    return this.cheques.bounce(id, dto.reasonCode);
  }

  @Post('finance/cheques/:id/return')
  @ApiOperation({
    summary:
      'Give a cheque back before it is deposited; a payment it made is reversed',
  })
  @ApiCreatedResponse({ type: ChequeView })
  giveBack(
    @Param('id', parseId()) id: string,
    @Body() dto: ChequeReasonDto,
  ): Promise<ChequeView> {
    return this.cheques.giveBack(id, dto.reasonCode);
  }
}
