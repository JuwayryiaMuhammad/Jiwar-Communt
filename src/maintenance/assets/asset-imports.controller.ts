import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { AssetImportsService } from './asset-imports.service';
import { CheckAssetImportDto } from './dto/asset-imports.dto';
import { AssetImportView } from './views/asset-import.views';

/** Asset sheets (ADR 0064): checked whole, then applied once. */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance/asset-imports')
export class AssetImportsController {
  constructor(private readonly imports: AssetImportsService) {}

  @Get()
  @ApiOperation({ summary: 'List asset imports, newest first' })
  @ApiOkResponse({ type: ListOf(AssetImportView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<AssetImportView>> {
    return toList(await this.imports.list(q), (i) => AssetImportView.from(i));
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Check an asset sheet: valid, or its problems' })
  @ApiCreatedResponse({ type: AssetImportView })
  async check(@Body() dto: CheckAssetImportDto): Promise<AssetImportView> {
    return AssetImportView.from(await this.imports.check(dto.fileId));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an asset import' })
  @ApiOkResponse({ type: AssetImportView })
  async get(@Param('id', parseId()) id: string): Promise<AssetImportView> {
    return AssetImportView.from(await this.imports.get(id));
  }

  @Post(':id/apply')
  @ApiOperation({
    summary: 'Apply a valid import: every row, or none (then it is invalid)',
  })
  @ApiCreatedResponse({ type: AssetImportView })
  async apply(@Param('id', parseId()) id: string): Promise<AssetImportView> {
    return AssetImportView.from(await this.imports.apply(id));
  }
}
