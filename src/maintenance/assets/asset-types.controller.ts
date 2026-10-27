import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
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
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { AssetTypesService } from './asset-types.service';
import { CreateAssetTypeDto, UpdateAssetTypeDto } from './dto/asset-types.dto';
import { AssetTypeView } from './views/asset-type.views';

/** The compound's kinds of asset (ADR 0064). */
@ApiArea('maintenance')
@Controller('maintenance/asset-types')
export class AssetTypesController {
  constructor(private readonly types: AssetTypesService) {}

  @Get()
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'List asset types' })
  @ApiOkResponse({ type: ListOf(AssetTypeView) })
  async list(): Promise<ListResponse<AssetTypeView>> {
    return bounded(await this.types.list(), (t) => AssetTypeView.from(t));
  }

  @Post()
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Add an asset type' })
  @ApiCreatedResponse({ type: AssetTypeView })
  async create(@Body() dto: CreateAssetTypeDto): Promise<AssetTypeView> {
    return AssetTypeView.from(await this.types.create(dto));
  }

  @Patch(':id')
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Update or retire an asset type' })
  @ApiOkResponse({ type: AssetTypeView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateAssetTypeDto,
  ): Promise<AssetTypeView> {
    return AssetTypeView.from(await this.types.update(id, dto));
  }
}
