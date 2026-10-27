import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ContractsService } from './contracts.service';
import { NewContractDto } from './dto/contracts.dto';
import {
  ContractReadView,
  ContractView,
  EndOptionsView,
  RenewalView,
  StaffRenewalView,
} from './views/contract.views';

/** A resident's contracts (ADR 0062): their own, and the leases of what they own. */
@ApiArea('units')
@RequirePermissions('units.read')
@Controller()
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get('me/contracts')
  @ApiOperation({ summary: 'My contracts' })
  @ApiOkResponse({ type: [ContractView] })
  async mine(): Promise<ContractView[]> {
    return (await this.contracts.mine()).map((c) => ContractView.from(c));
  }

  @Get('units/:unitId/contracts/:id')
  @ApiOperation({ summary: 'Open a contract' })
  @NoStore()
  @ApiOkResponse({ type: ContractReadView })
  async open(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<ContractReadView> {
    const { contract, read } = await this.contracts.open(unitId, id);
    return ContractReadView.fromRead(contract, read);
  }

  @Get('units/:unitId/contracts/:id/end-options')
  @ApiOperation({ summary: 'A lease’s end: renew or move out' })
  @ApiOkResponse({ type: EndOptionsView })
  async endOptions(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<EndOptionsView> {
    return EndOptionsView.from(await this.contracts.endOptions(unitId, id));
  }

  /** A tenant the lease binds; one open per lease (CONTRACT_RENEWAL_OPEN). */
  @Post('units/:unitId/contracts/:id/renewal-requests')
  @ApiOperation({ summary: 'Ask to renew a lease' })
  @ApiCreatedResponse({ type: RenewalView })
  async askRenewal(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<RenewalView> {
    return RenewalView.from(await this.contracts.askRenewal(unitId, id));
  }

  @Post('contract-renewals/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my renewal request' })
  @ApiOkResponse({ type: RenewalView })
  async withdraw(@Param('id', parseId()) id: string): Promise<RenewalView> {
    return RenewalView.from(await this.contracts.withdrawRenewal(id));
  }
}

/** A unit's contracts, the management's side (ADR 0062). */
@ApiArea('units')
@RequirePermissions('contracts.manage')
@Controller('staff')
export class StaffContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get('units/:unitId/contracts')
  @ApiOperation({ summary: 'A unit’s contracts' })
  @ApiOkResponse({ type: [ContractView] })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ContractView[]> {
    return (await this.contracts.staffList(unitId)).map((c) =>
      ContractView.from(c),
    );
  }

  @Get('units/:unitId/contracts/:id')
  @ApiOperation({ summary: 'Open a unit’s contract' })
  @NoStore()
  @ApiOkResponse({ type: ContractReadView })
  async open(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<ContractReadView> {
    const { contract, read } = await this.contracts.staffOpen(unitId, id);
    return ContractReadView.fromRead(contract, read);
  }

  @Post('units/:unitId/contracts')
  @ApiOperation({ summary: 'Record a contract' })
  @ApiCreatedResponse({ type: ContractView })
  async record(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewContractDto,
  ): Promise<ContractView> {
    return ContractView.from(await this.contracts.record(unitId, dto));
  }

  @Post('contracts/:id/void')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Void a contract recorded by mistake' })
  @ApiOkResponse({ type: ContractView })
  async voidContract(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<ContractView> {
    return ContractView.from(await this.contracts.voidContract(id, dto));
  }

  @Get('contract-renewals')
  @ApiOperation({ summary: 'Open lease renewal requests' })
  @ApiOkResponse({ type: [StaffRenewalView] })
  async renewals(): Promise<StaffRenewalView[]> {
    return (await this.contracts.renewals()).map((r) =>
      StaffRenewalView.fromStaff(r),
    );
  }

  @Post('contract-renewals/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a renewal request, with a code' })
  @ApiOkResponse({ type: RenewalView })
  async decline(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<RenewalView> {
    return RenewalView.from(await this.contracts.declineRenewal(id, dto));
  }
}
