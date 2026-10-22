import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { ApiArea, NoStore } from '../common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../common/http/list';
import {
  ResidentItemsQueryDto,
  ResidentSearchQueryDto,
} from './dto/resident-items.dto';
import { ResidentItemView } from './resident-item.views';
import { ResidentItemsService } from './resident-items.service';

/**
 * A resident's lists across the domains (ADR 0058). No permission: the
 * account kind decides (residents and family), and each source its items.
 */
@ApiArea('me')
@Controller('me')
export class ResidentItemsController {
  constructor(private readonly items: ResidentItemsService) {}

  @Get('requests')
  @ApiOperation({
    summary:
      'List everything I asked for: tickets, requests, disputes, permits, complaints',
  })
  @NoStore()
  @ApiOkResponse({ type: ListOf(ResidentItemView) })
  async requests(
    @Query() q: ResidentItemsQueryDto,
  ): Promise<ListResponse<ResidentItemView>> {
    return toList(await this.items.list('request', q), (i) =>
      ResidentItemView.from(i),
    );
  }

  @Get('appeals')
  @ApiOperation({ summary: 'List my appeals and where each stands' })
  @NoStore()
  @ApiOkResponse({ type: ListOf(ResidentItemView) })
  async appeals(
    @Query() q: ResidentItemsQueryDto,
  ): Promise<ListResponse<ResidentItemView>> {
    return toList(await this.items.list('appeal', q), (i) =>
      ResidentItemView.from(i),
    );
  }

  /** At most 10 of a kind and 50 in all; 30 searches a minute. */
  @Get('search')
  @ApiOperation({ summary: 'Search my own items by reference or name' })
  @NoStore()
  @ApiOkResponse({ type: ListOf(ResidentItemView) })
  async search(
    @Query() q: ResidentSearchQueryDto,
  ): Promise<ListResponse<ResidentItemView>> {
    return bounded(await this.items.search(q.q), (i) =>
      ResidentItemView.from(i),
    );
  }
}
