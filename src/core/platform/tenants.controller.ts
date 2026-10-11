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
import { ApiArea } from '../common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { UpdateAccountStatusDto } from '../accounts/dto/update-account-status.dto';
import {
  CreateTenantDto,
  NewManagerDto,
  TenantStatusDto,
} from './dto/platform.dto';
import { PlatformAuth } from './platform-auth.guard';
import { TenantsService } from './tenants.service';
import {
  ManagerView,
  TenantDetailView,
  TenantView,
} from './views/platform.views';

/** Compounds and their managers, from the platform owner's side (ADR 0011). */
@ApiArea('platform', 'platform')
@PlatformAuth()
@Controller('platform/tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @ApiOperation({ summary: 'List compounds' })
  @ApiOkResponse({ type: ListOf(TenantView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<TenantView>> {
    return toList(await this.tenants.list(q), (t) => TenantView.from(t));
  }

  /** The compound, its roles and settings, and its first manager. */
  @Post()
  @ApiOperation({ summary: 'Create a compound with its first manager' })
  @ApiCreatedResponse({ type: TenantDetailView })
  async create(@Body() dto: CreateTenantDto): Promise<TenantDetailView> {
    return TenantDetailView.fromDetails(
      await this.tenants.createTenant({ name: dto.name, manager: dto.manager }),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one compound' })
  @ApiOkResponse({ type: TenantDetailView })
  async get(@Param('id', parseId()) id: string): Promise<TenantDetailView> {
    return TenantDetailView.fromDetails(await this.tenants.get(id));
  }

  /** Suspending ends every session in the compound at once. */
  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate or suspend a compound' })
  @ApiOkResponse({ type: TenantView })
  async setStatus(
    @Param('id', parseId()) id: string,
    @Body() dto: TenantStatusDto,
  ): Promise<TenantView> {
    return TenantView.from(await this.tenants.setStatus(id, dto.status));
  }

  @Post(':id/managers')
  @ApiOperation({ summary: 'Add a manager to a compound' })
  @ApiCreatedResponse({ type: ManagerView })
  async addManager(
    @Param('id', parseId()) id: string,
    @Body() dto: NewManagerDto,
  ): Promise<ManagerView> {
    return ManagerView.from(await this.tenants.addManager(id, dto));
  }

  @Patch(':id/managers/:accountId/status')
  @ApiOperation({ summary: "Activate or deactivate a compound's manager" })
  @ApiOkResponse({ type: ManagerView })
  async setManagerStatus(
    @Param('id', parseId()) id: string,
    @Param('accountId', parseId('accountId')) accountId: string,
    @Body() dto: UpdateAccountStatusDto,
  ): Promise<ManagerView> {
    return ManagerView.from(
      await this.tenants.setManagerStatus(id, accountId, dto.status),
    );
  }
}
