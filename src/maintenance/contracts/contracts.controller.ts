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
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import { MaintenanceContractsService } from './contracts.service';
import {
  ContractAssetsDto,
  ContractPaymentsDto,
  ContractsQueryDto,
  CreateContractDto,
  DuePaymentsQueryDto,
  PayContractPaymentDto,
  RenewContractDto,
  UpdateContractDto,
} from './dto/contracts.dto';
import {
  ContractPaymentView,
  CoveringContractView,
  DueContractPaymentView,
  MaintenanceContractView,
} from './views/contract.views';

/** The compound's maintenance contracts (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance/contracts')
export class MaintenanceContractsController {
  constructor(private readonly contracts: MaintenanceContractsService) {}

  @Get()
  @ApiOperation({ summary: 'List contracts by end date' })
  @ApiOkResponse({ type: ListOf(MaintenanceContractView) })
  async list(
    @Query() q: ContractsQueryDto,
  ): Promise<ListResponse<MaintenanceContractView>> {
    return toList(await this.contracts.list(q), (c) =>
      MaintenanceContractView.from(c),
    );
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Record a contract' })
  @ApiCreatedResponse({ type: MaintenanceContractView })
  async create(
    @Body() dto: CreateContractDto,
  ): Promise<MaintenanceContractView> {
    return MaintenanceContractView.from(await this.contracts.create(dto));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a contract' })
  @ApiOkResponse({ type: MaintenanceContractView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<MaintenanceContractView> {
    return MaintenanceContractView.from(await this.contracts.get(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a contract’s terms' })
  @ApiOkResponse({ type: MaintenanceContractView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateContractDto,
  ): Promise<MaintenanceContractView> {
    return MaintenanceContractView.from(await this.contracts.update(id, dto));
  }

  @Put(':id/assets')
  @ApiOperation({ summary: 'Set the assets a contract covers' })
  @ApiOkResponse({ type: MaintenanceContractView })
  async setAssets(
    @Param('id', parseId()) id: string,
    @Body() dto: ContractAssetsDto,
  ): Promise<MaintenanceContractView> {
    return MaintenanceContractView.from(
      await this.contracts.setAssets(id, dto.assetIds),
    );
  }

  /** A new contract naming this one, once (ADR 0077). */
  @Post(':id/renew')
  @Idempotent()
  @ApiOperation({
    summary: 'Renew a contract',
    description:
      'A new contract with the same vendor, kind, scope, terms, budget line and assets still in service, from the day after its end by default.',
  })
  @ApiCreatedResponse({ type: MaintenanceContractView })
  async renew(
    @Param('id', parseId()) id: string,
    @Body() dto: RenewContractDto,
  ): Promise<MaintenanceContractView> {
    return MaintenanceContractView.from(await this.contracts.renew(id, dto));
  }

  @Get(':id/payments')
  @ApiOperation({
    summary: 'List a contract’s payment schedule',
    description: 'By day.',
  })
  @ApiOkResponse({ type: ListOf(ContractPaymentView) })
  async payments(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<ContractPaymentView>> {
    return bounded(await this.contracts.payments(id), (p) =>
      ContractPaymentView.from(p),
    );
  }

  @Put(':id/payments')
  @ApiOperation({
    summary: 'Set a contract’s payment schedule',
    description: 'Every unpaid payment, replaced whole; what is paid stays.',
  })
  @ApiOkResponse({ type: ListOf(ContractPaymentView) })
  async schedule(
    @Param('id', parseId()) id: string,
    @Body() dto: ContractPaymentsDto,
  ): Promise<ListResponse<ContractPaymentView>> {
    return bounded(await this.contracts.schedule(id, dto.payments), (p) =>
      ContractPaymentView.from(p),
    );
  }

  @Post(':id/payments/:paymentId/pay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a contract payment paid',
    description: 'Once.',
  })
  @ApiOkResponse({ type: ContractPaymentView })
  async pay(
    @Param('id', parseId()) id: string,
    @Param('paymentId', parseId('paymentId')) paymentId: string,
    @Body() dto: PayContractPaymentDto,
  ): Promise<ContractPaymentView> {
    return ContractPaymentView.from(
      await this.contracts.pay(id, paymentId, dto),
    );
  }

  /** `reasonCode` from the closed list `contractTerminate`. */
  @Post(':id/terminate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a contract before its date' })
  @ApiOkResponse({ type: MaintenanceContractView })
  async terminate(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<MaintenanceContractView> {
    return MaintenanceContractView.from(
      await this.contracts.terminate(id, dto.reasonCode),
    );
  }
}

/** What the contracts have due and unpaid in a window (ADR 0077). */
@ApiArea('maintenance')
@RequireAnyPermission('assets.manage', 'finance.budget')
@Controller('maintenance/contract-payments')
export class ContractPaymentsDueController {
  constructor(private readonly contracts: MaintenanceContractsService) {}

  @Get('due')
  @ApiOperation({
    summary: 'List the contract payments due',
    description:
      'Unpaid, between two days, of contracts not terminated: next month’s commitments. At most 500, by day.',
  })
  @ApiOkResponse({ type: ListOf(DueContractPaymentView) })
  async due(
    @Query() q: DuePaymentsQueryDto,
  ): Promise<ListResponse<DueContractPaymentView>> {
    return bounded(await this.contracts.due(q), (d) =>
      DueContractPaymentView.ofDue(d),
    );
  }
}

/** Who to call about an asset (ADR 0065): its active contracts, no money. */
@ApiArea('maintenance')
@RequirePermissions('assets.read')
@Controller('maintenance/assets/:id/contracts')
export class AssetContractsController {
  constructor(private readonly contracts: MaintenanceContractsService) {}

  @Get()
  @ApiOperation({ summary: 'List the contracts covering an asset now' })
  @ApiOkResponse({ type: ListOf(CoveringContractView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<CoveringContractView>> {
    return bounded(await this.contracts.ofAsset(id), (c) =>
      CoveringContractView.from(c),
    );
  }
}
