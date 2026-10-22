import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { DiscoveryService } from './discovery.service';
import { PartnersQueryDto } from './dto/discovery.dto';
import { PartnerView } from './views/partner.views';

/** The compound's partners, as residents find them (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.request')
@Controller('partners')
export class PartnersController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary:
      'List the active partners: by category, open now, open late tonight, new, favourites',
  })
  @ApiOkResponse({ type: ListOf(PartnerView) })
  async list(
    @Query() query: PartnersQueryDto,
  ): Promise<ListResponse<PartnerView>> {
    return bounded(
      await this.discovery.list({
        category: query.category,
        subcategoryId: query.subcategoryId,
        openNow: query.openNow === 'true',
        openLate: query.openLate === 'true',
        new: query.new === 'true',
        favourites: query.favourites === 'true',
      }),
      (p) => PartnerView.from(p),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a partner' })
  @ApiOkResponse({ type: PartnerView })
  async get(@Param('id', parseId()) id: string): Promise<PartnerView> {
    return PartnerView.from(await this.discovery.get(id));
  }

  @Put(':id/favourite')
  @HttpCode(204)
  @ApiOperation({ summary: 'Keep a partner among the caller’s favourites' })
  @ApiNoContentResponse()
  async favourite(@Param('id', parseId()) id: string): Promise<void> {
    await this.discovery.favourite(id);
  }

  @Delete(':id/favourite')
  @HttpCode(204)
  @ApiOperation({ summary: 'Take a partner off the caller’s favourites' })
  @ApiNoContentResponse()
  async unfavourite(@Param('id', parseId()) id: string): Promise<void> {
    await this.discovery.unfavourite(id);
  }
}
