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
  ContractsQueryDto,
  CreateContractDto,
  UpdateContractDto,
} from './dto/contracts.dto';
import {
  MaintenanceContractView,
  CoveringContractView,
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
