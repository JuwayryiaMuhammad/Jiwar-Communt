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
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { IssuedTagView } from '../locations/views/common-area.views';
import { AssetsService } from './assets.service';
import {
  AssetsQueryDto,
  AssetStatusDto,
  CreateAssetDto,
  MoveAssetDto,
  RetireAssetDto,
  UpdateAssetDto,
} from './dto/assets.dto';
import {
  AssetEventView,
  AssetImpactView,
  AssetSummaryView,
  AssetView,
} from './views/asset.views';

/** The asset register (ADR 0064). */
@ApiArea('maintenance')
@Controller('maintenance/assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'List assets, newest first' })
  @ApiOkResponse({ type: ListOf(AssetSummaryView) })
  async list(
    @Query() q: AssetsQueryDto,
  ): Promise<ListResponse<AssetSummaryView>> {
    return toList(await this.assets.list(q), (a) => AssetSummaryView.from(a));
  }

  @Post()
  @RequirePermissions('assets.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Add an asset' })
  @ApiCreatedResponse({ type: AssetView })
  async create(@Body() dto: CreateAssetDto): Promise<AssetView> {
    return AssetView.fromCard(await this.assets.create(dto));
  }

  @Get(':id')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'Get an asset’s card' })
  @ApiOkResponse({ type: AssetView })
  async get(@Param('id', parseId()) id: string): Promise<AssetView> {
    return AssetView.fromCard(await this.assets.card(id));
  }

  @Patch(':id')
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Update an asset’s card' })
  @ApiOkResponse({ type: AssetView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateAssetDto,
  ): Promise<AssetView> {
    return AssetView.fromCard(await this.assets.update(id, dto));
  }

  @Post(':id/status')
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Put an asset in or out of service' })
  @ApiCreatedResponse({ type: AssetView })
  async status(
    @Param('id', parseId()) id: string,
    @Body() dto: AssetStatusDto,
  ): Promise<AssetView> {
    return AssetView.fromCard(await this.assets.setStatus(id, dto));
  }

  @Post(':id/retire')
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Retire an asset for good' })
  @ApiCreatedResponse({ type: AssetView })
  async retire(
    @Param('id', parseId()) id: string,
    @Body() dto: RetireAssetDto,
  ): Promise<AssetView> {
    return AssetView.fromCard(await this.assets.retire(id, dto));
  }

  @Post(':id/move')
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary: 'Move a root asset, with its parts, to another place',
  })
  @ApiCreatedResponse({ type: AssetView })
  async move(
    @Param('id', parseId()) id: string,
    @Body() dto: MoveAssetDto,
  ): Promise<AssetView> {
    return AssetView.fromCard(await this.assets.move(id, dto));
  }

  /** No-store: the response is the tag's secret, shown once. */
  @Post(':id/tag')
  @NoStore()
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary: 'Issue a new QR tag; the previous one stops working',
  })
  @ApiCreatedResponse({ type: IssuedTagView })
  issueTag(@Param('id', parseId()) id: string): Promise<IssuedTagView> {
    return this.assets.issueTag(id);
  }

  @Get(':id/events')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'An asset’s history, newest first' })
  @ApiOkResponse({ type: ListOf(AssetEventView) })
  async events(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<AssetEventView>> {
    return toList(await this.assets.events(id, q), (e) =>
      AssetEventView.from(e),
    );
  }

  @Get(':id/impact')
  @RequirePermissions('assets.read')
  @ApiOperation({
    summary: 'Who an asset’s failure reaches: buildings and unit counts',
  })
  @ApiOkResponse({ type: AssetImpactView })
  impact(@Param('id', parseId()) id: string): Promise<AssetImpactView> {
    return this.assets.impact(id);
  }
}
