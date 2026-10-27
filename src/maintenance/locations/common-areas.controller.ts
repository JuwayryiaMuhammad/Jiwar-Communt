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
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { CommonAreasService } from './common-areas.service';
import {
  CommonAreasQueryDto,
  CreateCommonAreaDto,
  UpdateCommonAreaDto,
} from './dto/common-areas.dto';
import { CommonAreaView, IssuedTagView } from './views/common-area.views';

/** The compound's common areas (ADR 0064). */
@ApiArea('maintenance')
@Controller('maintenance/areas')
export class CommonAreasController {
  constructor(private readonly areas: CommonAreasService) {}

  @Get()
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'List common areas, oldest first' })
  @ApiOkResponse({ type: ListOf(CommonAreaView) })
  async list(
    @Query() q: CommonAreasQueryDto,
  ): Promise<ListResponse<CommonAreaView>> {
    return toList(await this.areas.list(q), (a) => CommonAreaView.from(a));
  }

  @Post()
  @RequirePermissions('assets.manage')
  @Idempotent()
  @ApiOperation({ summary: 'Add a common area' })
  @ApiCreatedResponse({ type: CommonAreaView })
  async create(@Body() dto: CreateCommonAreaDto): Promise<CommonAreaView> {
    return CommonAreaView.from(await this.areas.create(dto));
  }

  @Get(':id')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'Get a common area' })
  @ApiOkResponse({ type: CommonAreaView })
  async get(@Param('id', parseId()) id: string): Promise<CommonAreaView> {
    return CommonAreaView.from(await this.areas.get(id));
  }

  @Patch(':id')
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Update or retire a common area' })
  @ApiOkResponse({ type: CommonAreaView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateCommonAreaDto,
  ): Promise<CommonAreaView> {
    return CommonAreaView.from(await this.areas.update(id, dto));
  }

  /** No-store: the response is the tag's secret, shown once. */
  @Post(':id/tag')
  @NoStore()
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary: 'Issue a new QR tag for the area; the previous one stops working',
  })
  @ApiCreatedResponse({ type: IssuedTagView })
  issueTag(@Param('id', parseId()) id: string): Promise<IssuedTagView> {
    return this.areas.issueTag(id);
  }
}
